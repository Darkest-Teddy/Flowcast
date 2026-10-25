import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * The tips carousel on the loading screen (IntroScreen): a glass card over the intro still that
 * cycles through what Flowcast can do while the map loads (~20 s on a first visit). It teaches
 * first-time users the features that aren't obvious from the map itself.
 *
 * Its state is local, like the progress state in IntroScreen, so advancing a tip re-renders only
 * this card.
 */

interface Tip {
  title: string;
  body: string;
  /** Where in the app the feature lives, under the body in secondary ink. */
  where: string;
  /** public/intro/tips/<shot>-wide.webp, a 1568×1120 (7:5) capture of the feature from the running app. */
  shot: string;
  alt: string;
}

const TIPS: Tip[] = [
  {
    title: 'Watch the campus move',
    body: 'Every building glows by how full it is, and its tag shows a level word and a percentage. Scrub the timeline, play at up to 600× speed, or switch to Clock to follow the real time in Boston.',
    where: 'Playback · top of the map',
    shot: 'crowds',
    alt: 'Commonwealth Avenue at 12:20 PM: buildings glowing by how full they are, each tagged with its percentage, and the playback controls at the top',
  },
  {
    title: 'Plan around campus events',
    body: 'During an event, students who are free attend it, up to the room’s published seat count, and the venue lights up on the map.',
    where: 'Events tab',
    shot: 'events',
    alt: 'A Thursday evening with the Events tab open on the day’s two campus events, and Agganis Arena on the map with 120 people at the play',
  },
  {
    title: 'See what an event changes',
    body: 'Pick any date on the calendar to see that day’s events and, for every place, hour-by-hour crowding with and without them.',
    where: 'Event impact',
    shot: 'impact',
    alt: 'The Event impact page for Thursday, October 29: the day’s two events with their simulated attendance, and hour-by-hour bars for Agganis Arena and the College of Arts and Sciences with and without them',
  },
  {
    title: 'Rehearse emergencies',
    body: 'Start a fire drill, alarm or closure on any building. Occupants evacuate, gather, then choose a feasible next place, compared against the normal day.',
    where: 'Log tab',
    shot: 'incidents',
    alt: 'The Log tab setting up a fire drill: the scenario chips, Yawkey Center as the centre and a 250 m radius, drawn on the map around it',
  },
  {
    title: 'Ask where to go',
    body: 'Try “Least crowded library right now” or “Quietest dining hall at 6 PM”. Answers come from the same simulation and walking routes the map uses.',
    where: 'Ask · bottom of the map',
    shot: 'ask',
    alt: 'Ask answering “Least crowded library right now” with the libraries ranked by how full they are, and Mugar Memorial Library picked out on the map',
  },
  {
    title: 'Never colour alone',
    body: 'Crowd levels use three steps, Quiet, Busy and Packed, always with a word, a percentage and a one, two or three people icon.',
    where: 'Building tags',
    shot: 'levels',
    alt: 'Building tags along Commonwealth Avenue: Yawkey Center’s tag opened at 100% Packed, Saxbys at CDS at 92% in red, busy buildings in yellow and quiet ones in blue, with the crowd scale below them',
  },
];

/** How long each tip stays up before the next one takes over. */
const TIP_MS = 7000;

/** Which tip to open on: the one after the last one seen, so a returning visitor reads a new one. */
const SEEN_KEY = 'flowcast.tip';

function firstTip(): number {
  try {
    const seen = Number(window.localStorage.getItem(SEEN_KEY));
    if (Number.isInteger(seen)) return (((seen + 1) % TIPS.length) + TIPS.length) % TIPS.length;
  } catch {
    // storage blocked: start at the first tip
  }
  return 0;
}

export function IntroTips() {
  const [index, setIndex] = useState(firstTip);
  const [paused, setPaused] = useState(false);
  // Which shots have been asked for. The card is up while the map is still downloading, so only the
  // open tip's shot and the one after it are fetched; the rest follow as the carousel reaches them.
  const [wanted, setWanted] = useState(() => new Set([index, (index + 1) % TIPS.length]));
  // Restarts the dot's timer fill from zero whenever the tip changes or playback resumes, since the
  // animation is keyed on it.
  const [run, setRun] = useState(0);
  const timer = useRef(0);
  const reduced = useRef(false);

  useEffect(() => {
    reduced.current = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }, []);

  useEffect(() => {
    setWanted((seen) => (seen.has((index + 1) % TIPS.length) ? seen : new Set(seen).add((index + 1) % TIPS.length)));
    try {
      window.localStorage.setItem(SEEN_KEY, String(index));
    } catch {
      // storage blocked: the next visit starts at the first tip
    }
  }, [index]);

  // Auto-advance, held while the pointer or focus is in the card and when the reader asked for
  // less motion (then the card waits for the arrows).
  useEffect(() => {
    if (paused || reduced.current) return;
    timer.current = window.setTimeout(() => {
      setIndex((i) => (i + 1) % TIPS.length);
      setRun((r) => r + 1);
    }, TIP_MS);
    return () => window.clearTimeout(timer.current);
  }, [index, paused, run]);

  const go = useCallback((n: number) => {
    setIndex(((n % TIPS.length) + TIPS.length) % TIPS.length);
    setRun((r) => r + 1);
  }, []);

  return (
    <section
      className="intro-tips"
      aria-roledescription="carousel"
      aria-label="Flowcast tips"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <div className="intro-tips-row">
        <div className="intro-tips-text">
          <div className="intro-tips-eyebrow">
            <img src="/favicon.svg" alt="" width={16} height={16} />
            <span>Flowcast tip</span>
          </div>
          <div className="intro-tips-stack">
            {TIPS.map((tip, i) => (
              <div key={tip.shot} className={`intro-tip${i === index ? ' is-on' : ''}`} aria-hidden={i !== index}>
                <h2>{tip.title}</h2>
                <p className="intro-tip-body">{tip.body}</p>
                <p className="intro-tip-where">{tip.where}</p>
              </div>
            ))}
          </div>
          <div className="intro-tips-controls">
            <div className="intro-tips-dots" role="tablist" aria-label="Choose a tip">
              {TIPS.map((tip, i) => (
                <button
                  key={tip.shot}
                  type="button"
                  role="tab"
                  aria-selected={i === index}
                  aria-label={`Tip ${i + 1}: ${tip.title}`}
                  className={i === index ? 'is-on' : undefined}
                  onClick={() => go(i)}
                >
                  {i === index && (
                    <span
                      key={`${run}-${paused}`}
                      style={{ animationDuration: `${TIP_MS}ms`, animationPlayState: paused ? 'paused' : 'running' }}
                    />
                  )}
                </button>
              ))}
            </div>
            <div className="intro-tips-arrows">
              <button type="button" aria-label="Previous tip" onClick={() => go(index - 1)}>
                <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M14.5 6l-6 6 6 6" /></svg>
              </button>
              <button type="button" aria-label="Next tip" onClick={() => go(index + 1)}>
                <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M9.5 6l6 6-6 6" /></svg>
              </button>
            </div>
          </div>
        </div>
        <div className="intro-tips-shots">
          {TIPS.map((tip, i) => wanted.has(i) && (
            <img
              key={tip.shot}
              className={i === index ? 'is-on' : undefined}
              src={`/intro/tips/${tip.shot}-wide.webp`}
              alt={tip.alt}
              decoding="async"
            />
          ))}
          <div className="intro-tips-seam" aria-hidden="true" />
        </div>
      </div>
    </section>
  );
}
