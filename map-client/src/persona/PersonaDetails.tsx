/*
 * Who you just clicked: a joined student's name, their bio, and what they are going to do.
 *
 * Opens in the same bottom-left slot the join invitation uses, so clicking a character never covers
 * the map's own panels. Both lines come from persona/model.ts, which derives them from one
 * deterministic journey, so "right now" and "planning to" can never contradict each other.
 */

import { useEffect, useState } from 'react';
import { describe } from './parts';
import { JOINED_MARK, locationName, planText, statusText, type Persona } from './model';

/** The status and the plan are clock-driven; this re-reads them without touching the map's loop. */
function useWallClock(periodMs = 2000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), periodMs);
    return () => window.clearInterval(id);
  }, [periodMs]);
  return now;
}

export function PersonaDetails({
  persona,
  onClose,
  nowMs,
}: {
  persona: Persona;
  onClose: () => void;
  /**
   * Which clock to read the journey against, in ms.
   *
   * The map passes its simulation clock, so the card agrees with the character you can see walking
   * on screen even at 600x. The phone's own status screen leaves this out and gets wall time, since
   * it has no simulation clock of its own.
   */
  nowMs?: number;
}) {
  const wall = useWallClock();
  const now = nowMs ?? wall;

  // Escape closes it, like every other dismissable thing in the chrome.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <section className="persona-card" aria-labelledby="persona-card-name">
      <header className="persona-card-head">
        <h2 className="persona-card-name" id="persona-card-name">
          <span className="persona-card-mark" aria-hidden="true">
            {JOINED_MARK}
          </span>
          {persona.name}
        </h2>
        <button type="button" className="persona-card-close" onClick={onClose} aria-label={`Close details for ${persona.name}`}>
          <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true">
            <path d="M6 6l12 12M18 6 6 18" />
          </svg>
        </button>
      </header>

      {persona.bio ? (
        <p className="persona-card-bio">{persona.bio}</p>
      ) : (
        <p className="persona-card-bio is-empty">Joined the map · hangs out at {locationName(persona.homeLocationId)}</p>
      )}

      <dl className="persona-card-rows">
        <div className="persona-card-row">
          <dt>Right now</dt>
          <dd>
            <span className="persona-dot" aria-hidden="true" />
            {statusText(persona, now)}
          </dd>
        </div>
        <div className="persona-card-row">
          <dt>Planning to</dt>
          <dd>{planText(persona, now)}</dd>
        </div>
      </dl>

      <p className="persona-card-outfit">{describe(persona.appearance)}</p>
    </section>
  );
}
