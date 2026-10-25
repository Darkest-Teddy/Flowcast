// Contract between the Ask chat page (web /ask) and the Ask server's chat endpoints (server/).
// Types only, so both sides import it: the server as ../../map-client/src/chatContract, the web
// app as @map/chatContract.
//
// The honesty rule of /api/ask carries over: the model writes words and picks tools, but every
// number a person sees comes from a tool. Visuals are built by the server from tool outputs and
// are never written by the model.

import type { AgentShow, AskCampus } from './askClient';

// ---------------------------------------------------------------- POST /api/chat

export interface ChatTurn {
  role: 'user' | 'assistant';
  /** User turns: 1–300 characters. Assistant turns: the answer text sent back, at most 2000. */
  text: string;
}

export interface ChatRequest {
  /** The conversation so far, oldest first, at most 12 turns; the last turn is the new user question. */
  messages: ChatTurn[];
  /** 0 = Monday … 6 = Sunday: the reference-week day the question is about by default. */
  weekday: number;
  /** Seconds since midnight: "now" for the question. */
  time: number;
  campus: AskCampus;
  /** YYYY-MM-DD for an event day (Event impact), or null for the representative week. */
  date: string | null;
}

/** Where a figure comes from. Shown on every visual and citation. */
export type Provenance = 'simulated' | 'published' | 'assumption' | 'mixed';

interface VisualBase {
  /** Unique within one response. */
  id: string;
  title: string;
  source: Provenance;
  /** One short line, e.g. "Simulated students over published seats" or "FitRec entries, Oct 2026". */
  note: string | null;
}

/** Values over the day (or any ordered x axis). One series needs no legend; 2–4 series get one. */
export interface LineVisual extends VisualBase {
  kind: 'line';
  /** Unit of the y values, e.g. "% full", "students", "rides/h". */
  unit: string;
  /** X labels in order, e.g. ["6 AM", "7 AM", …]. */
  x: string[];
  /** 1–4 series, each the same length as x; null = no value (closed, not modeled). */
  series: { name: string; values: (number | null)[] }[];
  /** Optional highlight, e.g. the time the question is about. */
  marker: { index: number; label: string } | null;
}

/** A ranking or comparison of named things. */
export interface BarVisual extends VisualBase {
  kind: 'bar';
  unit: string;
  /** At most 12, in the order to show. level is a crowd word (Quiet/Busy/Packed) when it applies. */
  bars: { label: string; value: number | null; level: string | null; detail: string | null }[];
}

export interface TableVisual extends VisualBase {
  kind: 'table';
  columns: { key: string; label: string; align: 'left' | 'right' }[];
  /** At most 25 rows. */
  rows: Record<string, string | number | null>[];
}

/** A few headline figures. */
export interface StatsVisual extends VisualBase {
  kind: 'stats';
  /** 1–6 items; value is display text ("1,547", "71%", "Open until 10 PM"). */
  items: { label: string; value: string; detail: string | null }[];
}

export type Visual = LineVisual | BarVisual | TableVisual | StatsVisual;

export interface Citation {
  /** Human name of the dataset, e.g. "BU Fall 2026 class schedule". */
  label: string;
  /** Directory domain id it belongs to (see DataDomain.id). */
  domain: string;
  kind: Provenance;
  /** Public source page, when there is one. */
  url: string | null;
}

export interface ChatResponse {
  /**
   * The reply. A small markdown subset only: paragraphs, **bold**, and "- " bullet lists. No
   * headings, links, images, tables or code; visuals carry the data.
   */
  answer: string;
  /** At most 4, built by the server from this turn's tool calls, in the order to show. */
  visuals: Visual[];
  /** What the map should show for this answer, as in /api/ask. */
  show: AgentShow | null;
  /**
   * A relative link that opens the 3D map at the answer's moment, e.g.
   * "/map?at=12:20&speed=1" or "/map?date=2026-10-29&at=20:15&speed=1". Uses only the map's
   * existing URL parameters (at, speed, date, events, ask). Null when the answer has no moment.
   */
  mapLink: string | null;
  /** Datasets the answer drew on, de-duplicated. */
  sources: Citation[];
  /** 0–3 short follow-up questions the user can tap. */
  followUps: string[];
  model: string;
  /** Tool names in call order. */
  calls: string[];
}

// Errors use the same statuses and { error, retryAfter? } bodies as /api/ask:
// 400 bad input · 429 rate limit · 503 no key or day still being simulated (Retry-After) ·
// 504 model timeout · 502 model error.

// ---------------------------------------------------------------- GET /api/chat/directory

/** One area of knowledge the chat can answer from. Needs no OpenAI key. */
export interface DataDomain {
  /** Stable id, e.g. "crowds", "dining", "events", "transit", "bikes", "emergencies". */
  id: string;
  title: string;
  /** One or two plain sentences on what it covers. */
  description: string;
  datasets: {
    name: string;
    kind: Provenance;
    /** Period or snapshot, e.g. "Fall 2026", "Oct 2026", "retrieved 2026-10-24". */
    period: string | null;
    /** Public source page, when there is one. */
    url: string | null;
    /** Records or places covered, as display text ("3,805 class meetings"). */
    coverage: string | null;
  }[];
  /** 2–4 questions this domain answers well. */
  examples: string[];
}

export interface DirectoryResponse {
  domains: DataDomain[];
  /** Whether chat answers are available (an OpenAI key is configured). The directory works either way. */
  chatAvailable: boolean;
  model: string;
}
