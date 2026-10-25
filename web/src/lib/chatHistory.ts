// The /ask conversation: its messages, which of them go to the Ask server with the next question,
// the context (day, time, campus, event date) sent with it, and keeping it in sessionStorage.
// Type-only imports, so node --test runs it as is.

import type { ChatRequest, ChatResponse, ChatTurn } from '@map/chatContract';
import type { AskCampus } from '@map/askClient';
import type { ChatError } from './chatParse';

export const MAX_TURNS = 12;
export const MAX_QUESTION_CHARS = 300;
export const MAX_ASSISTANT_CHARS = 2000;

/** A row of an answer worked out on this device (personal questions). */
export interface DeviceRow {
  id: string;
  title: string;
  detail: string;
  share?: number | null;
}

export type ChatMessage =
  | { id: string; role: 'user'; text: string }
  /** `sample` is retained only to reject legacy development messages. */
  | { id: string; role: 'assistant'; status: 'answer'; response: ChatResponse; sample?: boolean }
  /** A personal question answered on this device. Never sent to the server, now or later. */
  | { id: string; role: 'assistant'; status: 'device'; text: string; rows: DeviceRow[]; note: string }
  /** A failed question, with what went wrong and the question so it can be asked again. */
  | { id: string; role: 'assistant'; status: 'error'; error: ChatError; question: string };

export interface ChatContext {
  /** 0 = Monday … 6 = Sunday. */
  weekday: number;
  /** "HH:MM", 24-hour, Boston time. */
  time: string;
  campus: AskCampus;
  /** YYYY-MM-DD or null. */
  date: string | null;
}

export const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;

export const CAMPUSES: { value: AskCampus; label: string }[] = [
  { value: 'charles-river', label: 'Charles River' },
  { value: 'fenway', label: 'Fenway' },
  { value: 'medical', label: 'Medical' },
];

/** Seconds since midnight to "HH:MM". */
export function clockText(seconds: number): string {
  const s = ((Math.floor(seconds) % 86400) + 86400) % 86400;
  return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`;
}

/** "HH:MM" (or "HH:MM:SS") to seconds since midnight; null when it isn't a time. */
export function clockSeconds(text: string): number | null {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(text.trim());
  if (!m) return null;
  const [h, min, s] = [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
  if (h > 23 || min > 59 || s > 59) return null;
  return h * 3600 + min * 60 + s;
}

/** Weekday (0 = Monday) of a YYYY-MM-DD date, or null when it isn't one. */
export function weekdayOfDate(date: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const d = new Date(`${date}T12:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== date) return null;
  return (d.getUTCDay() + 6) % 7;
}

/**
 * The turns sent with a new question: earlier question-and-answer pairs the server answered, oldest
 * first, then the new question; at most `max` turns, never starting with an answer. Personal
 * questions answered on this device, failed questions and dev samples are left out, so a schedule
 * never reaches the server through the history.
 */
export function historyForRequest(messages: ChatMessage[], question: string, max = MAX_TURNS): ChatTurn[] {
  const pairs: ChatTurn[] = [];
  for (let i = 0; i < messages.length - 1; i++) {
    const q = messages[i];
    const a = messages[i + 1];
    if (q.role === 'user' && a.role === 'assistant' && a.status === 'answer' && !a.sample) {
      pairs.push({ role: 'user', text: q.text.slice(0, MAX_QUESTION_CHARS) }, { role: 'assistant', text: a.response.answer.slice(0, MAX_ASSISTANT_CHARS) });
      i++;
    }
  }
  const room = Math.max(0, max - 1);
  let earlier = room === 0 ? [] : pairs.slice(-room);
  if (earlier[0]?.role === 'assistant') earlier = earlier.slice(1);
  return [...earlier, { role: 'user', text: question.trim().slice(0, MAX_QUESTION_CHARS) }];
}

/** The whole POST /api/chat body for a question in a conversation. */
export function buildChatRequest(messages: ChatMessage[], question: string, context: ChatContext): ChatRequest {
  return {
    messages: historyForRequest(messages, question),
    weekday: Math.min(6, Math.max(0, Math.round(context.weekday))),
    time: clockSeconds(context.time) ?? 12 * 3600,
    campus: context.campus,
    date: context.date && weekdayOfDate(context.date) !== null ? context.date : null,
  };
}

export const STORAGE_KEY = 'flowcast.askChat.v1';
/** Keep the stored conversation bounded; the oldest messages go first. */
export const MAX_STORED_MESSAGES = 60;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';

/** Messages to a JSON string for sessionStorage. Dev samples aren't kept. */
export function serializeConversation(messages: ChatMessage[]): string {
  return JSON.stringify(messages.filter((m) => !(m.role === 'assistant' && m.status === 'answer' && m.sample)).slice(-MAX_STORED_MESSAGES));
}

/**
 * A stored conversation back to messages. Anything unreadable is dropped; answers go through the
 * same parser as a live response (`parseBody`), so stored data is never trusted more than the network.
 */
export function restoreConversation(raw: string | null, parseBody: (body: unknown) => ChatResponse | null): ChatMessage[] {
  if (!raw) return [];
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const out: ChatMessage[] = [];
  for (const m of data.slice(-MAX_STORED_MESSAGES)) {
    if (!isObject(m) || !isStr(m.id) || m.sample === true) continue;
    if (m.role === 'user' && isStr(m.text) && m.text.trim()) {
      out.push({ id: m.id, role: 'user', text: m.text.slice(0, MAX_QUESTION_CHARS) });
    } else if (m.role === 'assistant' && m.status === 'answer') {
      const response = parseBody(m.response);
      if (response) out.push({ id: m.id, role: 'assistant', status: 'answer', response });
    } else if (m.role === 'assistant' && m.status === 'device' && isStr(m.text) && isStr(m.note)) {
      const rows = Array.isArray(m.rows)
        ? m.rows.filter((r): r is Record<string, unknown> => isObject(r) && isStr(r.id) && isStr(r.title) && isStr(r.detail)).map((r) => ({
            id: r.id as string,
            title: r.title as string,
            detail: r.detail as string,
            share: typeof r.share === 'number' && Number.isFinite(r.share) ? r.share : null,
          }))
        : [];
      out.push({ id: m.id, role: 'assistant', status: 'device', text: m.text, rows, note: m.note });
    } else if (m.role === 'assistant' && m.status === 'error' && isObject(m.error) && isStr(m.error.kind) && isStr(m.error.message) && isStr(m.question)) {
      out.push({ id: m.id, role: 'assistant', status: 'error', error: { kind: m.error.kind as ChatError['kind'], message: m.error.message }, question: m.question });
    }
  }
  return out;
}
