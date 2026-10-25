// A simulated Red Sox home game at Fenway Park, started from the Incidents tab: a sold-out game on
// the shown day at a chosen first pitch. It is a calendar event like the real ones in
// event-calendar.json, so the existing venue-event model does the rest: fans walk in from the T,
// the garages and rideshare drop-offs before first pitch, Fenway's tag shows the crowd, garages
// fill, and the crowd pours out at the final out. Real games at Fenway that day are replaced.
import type { CalendarEvent, EventSources } from '../data/eventCalendar';

export interface SimulatedGame {
  /** First pitch, seconds since midnight. */
  firstPitch: number;
  opponent: string;
}

export const GAME_ID = 'simulated:red-sox';
export const FENWAY = 'fenway-park';
/** A typical nine-inning game since the pitch clock (2023 on): about 2 h 40 min. */
export const GAME_MINUTES = 160;
export const OPPONENTS = ['New York Yankees', 'Tampa Bay Rays', 'Toronto Blue Jays', 'Baltimore Orioles', 'Los Angeles Dodgers'];

const pad = (n: number) => String(n).padStart(2, '0');
const clock = (seconds: number) => `${pad(Math.floor(seconds / 3600) % 24)}:${pad(Math.floor(seconds / 60) % 60)}:00`;

/** Boston's UTC offset on a date, as "-04:00" or "-05:00". */
function bostonOffset(date: string): string {
  const noon = new Date(`${date}T12:00:00Z`);
  const name = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'shortOffset' })
    .formatToParts(noon).find((part) => part.type === 'timeZoneName')?.value ?? 'GMT-5';
  const hours = Number(name.replace('GMT', '')) || -5;
  return `${hours < 0 ? '-' : '+'}${pad(Math.abs(hours))}:00`;
}

/** The game as a calendar event on `date` (YYYY-MM-DD). A game that runs past midnight ends the next day. */
export function simulatedGameEvent(date: string, game: SimulatedGame): CalendarEvent {
  const offset = bostonOffset(date);
  const end = game.firstPitch + GAME_MINUTES * 60;
  const endDate = end >= 86400 ? new Date(Date.parse(`${date}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10) : date;
  return {
    id: GAME_ID,
    venueId: FENWAY,
    name: `Red Sox vs. ${game.opponent} (simulated)`,
    kind: 'mlb',
    setup: game.firstPitch < 17 * 3600 ? 'ballpark-day' : 'ballpark',
    start: `${date}T${clock(game.firstPitch)}${offset}`,
    end: `${endDate}T${clock(end)}${offset}`,
    doors: null,
    timeTbd: false,
    performers: [],
    opponent: game.opponent,
    trendsTerms: ['Red Sox'],
    soldOut: true,
    source: 'simulated',
    sourceUrl: '',
  };
}

/** The event sources with the game added on `date`, in place of any real game at Fenway that day. */
export function withSimulatedGame(sources: EventSources, date: string | null, game: SimulatedGame | null): EventSources {
  if (!game || !date || !sources.calendar) return sources;
  const events = sources.calendar.events.filter((event) => !(event.venueId === FENWAY && event.start.slice(0, 10) === date));
  return { ...sources, calendar: { ...sources.calendar, events: [...events, simulatedGameEvent(date, game)] } };
}
