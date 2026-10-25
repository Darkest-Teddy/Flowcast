// "Was it busy?": the once-per-visit question after a suggested place, "Report how busy it is now",
// and the modest line that shows what students reported. Reports are anonymous counts per place and
// Boston hour on the server; this browser only remembers which suggestions it has already asked about.
import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { api, useResource } from '../../data/api';
import type { CampusLocation, CrowdAnswer, CrowdReportSummary } from '../../data/types';
import { bostonTime } from '../../lib/departure';
import { formatHour } from '../../lib/format';
import {
  addSuggestion, ANSWER_LABEL, bostonHour, CROWD_STORAGE_KEY, emptyPromptState, markHandled, parsePromptState, pickPrompt,
  reportSummary, type CrowdPromptState, type CrowdSuggestion, type SuggestionSource,
} from '../../lib/crowdReports';
import { Button } from '../../ui';
import styles from './CrowdReport.module.css';

/** One id per app open: a suggestion is only asked about on a later open. */
const OPEN_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const ANSWERS: CrowdAnswer[] = ['quiet', 'ok', 'packed'];
export const PRIVACY_NOTE = 'Anonymous: your answer only adds one to a count for this place and hour. It isn’t saved to your account or linked to your schedule.';

function load(): CrowdPromptState {
  try { return parsePromptState(window.localStorage.getItem(CROWD_STORAGE_KEY)); } catch { return emptyPromptState(); }
}
function save(state: CrowdPromptState) {
  try { window.localStorage.setItem(CROWD_STORAGE_KEY, JSON.stringify(state)); } catch { /* Storage may be disabled; then the app just doesn't ask. */ }
}

/** Remember that the app suggested this place for around `at`, so a later open can ask how it was. */
export function rememberCrowdSuggestion(locationId: string, at: number, source: SuggestionSource, now = Date.now()) {
  const before = load();
  const after = addSuggestion(before, { locationId, at, source, openId: OPEN_ID }, now);
  if (JSON.stringify(after) !== JSON.stringify(before)) save(after);
}

/** Recent student reports, shared by every component on the page for a minute. */
let cached: { at: number; promise: Promise<CrowdReportSummary> } | undefined;
function crowdReports() {
  if (!cached || Date.now() - cached.at > 60_000) {
    const promise = api.getCrowdReports();
    cached = { at: Date.now(), promise };
    promise.catch(() => { if (cached?.promise === promise) cached = undefined; });
  }
  return cached.promise;
}
export function useCrowdReports() { return useResource(crowdReports).data; }

function errorText(error: unknown) {
  const message = error instanceof Error ? error.message : '';
  if (message.includes('(429)')) return 'You already reported this place in the last hour.';
  if (message.includes('sign in')) return 'Sign in to send a report.';
  return 'Couldn’t send that. Please try again later.';
}

function Answers({ onAnswer, disabled, skip }: { onAnswer: (answer: CrowdAnswer) => void; disabled: boolean; skip?: () => void }) {
  return (
    <div className={styles.answers} role="group" aria-label="How busy was it?">
      {ANSWERS.map((answer) => <Button key={answer} size="sm" disabled={disabled} onClick={() => onAnswer(answer)}>{ANSWER_LABEL[answer]}</Button>)}
      {skip && <Button size="sm" variant="ghost" disabled={disabled} onClick={skip}>Didn’t go</Button>}
    </div>
  );
}

/** The prompt shown this open (at most one), kept across page changes until it's answered or dismissed. */
let openPrompt: { suggestion: CrowdSuggestion | null; closed: boolean } | undefined;

/** "Were you at Marciano around 12:10?" Asked once, on a later open, about the latest suggested visit. */
export function CrowdReportPrompt({ locations }: { locations: CampusLocation[] }) {
  const [prompt] = useState(() => {
    if (!openPrompt) {
      const state = load();
      const suggestion = pickPrompt(state, Date.now(), OPEN_ID);
      // Shown counts as handled: the app never asks about the same visit again.
      if (suggestion) save(markHandled(state, suggestion.id));
      openPrompt = { suggestion, closed: false };
    }
    return openPrompt;
  });
  const [status, setStatus] = useState<'asking' | 'sending' | 'thanks' | 'closed'>(prompt.closed ? 'closed' : 'asking');
  const [error, setError] = useState<string | null>(null);
  const suggestion = prompt.suggestion;
  const place = suggestion && locations.find((l) => l.id === suggestion.locationId);
  if (!suggestion || !place || status === 'closed') return null;
  const close = () => { prompt.closed = true; setStatus('closed'); };
  async function answer(value: CrowdAnswer) {
    setStatus('sending'); setError(null);
    try { await api.reportCrowd(suggestion!.locationId, value, suggestion!.at); prompt.closed = true; setStatus('thanks'); }
    catch (e) { setError(errorText(e)); setStatus('asking'); }
  }
  return (
    <section className={styles.prompt} aria-label="Was it busy?">
      <div className={styles.promptHead}>
        <p className={styles.question}>{status === 'thanks' ? `Thanks, that helps other students.` : `Were you at ${place.name} around ${bostonTime(suggestion.at)}? How busy was it?`}</p>
        <button type="button" className={styles.close} onClick={close} aria-label="Dismiss"><X size={16} aria-hidden /></button>
      </div>
      {status !== 'thanks' && <Answers onAnswer={answer} disabled={status === 'sending'} skip={close} />}
      {error && <p className={styles.error} role="alert">{error}</p>}
      <p className={styles.note}>{status === 'thanks' ? 'Counted anonymously. ' : ''}{PRIVACY_NOTE}</p>
    </section>
  );
}

/** "Report how busy it is now", for a place's own row or details. */
export function CrowdReportNow({ locationId, name }: { locationId: string; name: string }) {
  const [status, setStatus] = useState<'idle' | 'asking' | 'sending' | 'thanks'>('idle');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setStatus('idle'); setError(null); }, [locationId]);
  if (status === 'idle') return <Button size="sm" variant="ghost" className={styles.nowButton} onClick={() => setStatus('asking')}>Report how busy it is now</Button>;
  async function answer(value: CrowdAnswer) {
    setStatus('sending'); setError(null);
    try { await api.reportCrowd(locationId, value); setStatus('thanks'); }
    catch (e) { setError(errorText(e)); setStatus('asking'); }
  }
  return (
    <div className={styles.now}>
      <p className={styles.question}>{status === 'thanks' ? 'Thanks. Counted anonymously.' : `How busy is ${name} right now?`}</p>
      {status !== 'thanks' && <Answers onAnswer={answer} disabled={status === 'sending'} />}
      {error && <p className={styles.error} role="alert">{error}</p>}
      {status !== 'thanks' && <p className={styles.note}>{PRIVACY_NOTE}</p>}
    </div>
  );
}

/** One line of student reports, labelled as such and kept apart from the model projection. */
export function StudentReports({ summary, locationId, at, className }: { summary: CrowdReportSummary | null; locationId: string; at?: number; className?: string }) {
  const hour = at === undefined ? undefined : bostonHour(at);
  const text = reportSummary(summary, locationId, hour, hour === undefined ? undefined : formatHour(hour));
  if (!text) return null;
  return <p className={[styles.reports, className].filter(Boolean).join(' ')} title="Anonymous student reports, separate from the model projection.">{text} · not the model</p>;
}
