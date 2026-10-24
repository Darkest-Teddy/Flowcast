import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { config } from '../config';
import { Button } from '../ui';
import { tourPreviews, type TourPreviewId } from './account/TourPreviews';
import styles from './Welcome.module.css';

const steps: { id: TourPreviewId; title: string; body: string }[] = [
  {
    id: 'home',
    title: 'Home',
    body: 'Your day at a glance: what’s next on your schedule, how busy those places will be, and a quieter option when one is about to fill up.',
  },
  {
    id: 'schedule',
    title: 'Schedule and forecasts',
    body: 'Your classes come from your Google Calendar, each with a forecast of how full the room or dining hall will be when you arrive. Forecasts shows any place hour by hour.',
  },
  {
    id: 'map',
    title: 'The 3D map',
    body: 'Watch simulated students move between classes, dining halls and dorms. Your own agent follows your real week, so the crowds you see include you.',
  },
  {
    id: 'clubs',
    title: 'Clubs and events',
    body: 'Follow clubs to see their events in Flowcast. The Flowcast team verifies every club first, and club events stay in Flowcast, never in your Google Calendar.',
  },
  {
    id: 'privacy',
    title: 'Privacy',
    body: 'Choose which calendars Flowcast reads, download everything it keeps about you, or delete it all, from Privacy & data in the sidebar.',
  },
];

export default function Welcome() {
  const navigate = useNavigate();
  const [index, setIndex] = useState(0);
  const step = steps[index];
  const last = index === steps.length - 1;
  const Preview = tourPreviews[step.id];

  const go = useCallback((next: number) => setIndex(Math.max(0, Math.min(steps.length - 1, next))), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [role="radiogroup"]')) return;
      if (e.key === 'ArrowRight') go(index + 1);
      if (e.key === 'ArrowLeft') go(index - 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [index, go]);

  return (
    <div className={styles.screen}>
      <header className={styles.top}>
        <div className={styles.brand}>
          <span className={styles.mark} aria-hidden />
          <span>{config.appName}</span>
        </div>
        {!last && (
          <Button variant="ghost" onClick={() => navigate('/')}>
            Skip the tour
          </Button>
        )}
      </header>

      <main className={styles.stage}>
        <section className={styles.text} aria-live="polite" aria-labelledby="tour-title">
          <p className={styles.count}>
            Step {index + 1} of {steps.length}
          </p>
          <h1 id="tour-title" className={styles.title}>
            {step.title}
          </h1>
          <p className={styles.body}>{step.body}</p>
        </section>

        <div className={styles.preview}>
          <Preview />
        </div>
      </main>

      <footer className={styles.controls}>
        <Button variant="secondary" onClick={() => go(index - 1)} disabled={index === 0}>
          Back
        </Button>

        <ol className={styles.dots} aria-label="Tour steps">
          {steps.map((s, i) => (
            <li key={s.id}>
              <button
                type="button"
                className={i === index ? styles.dotOn : styles.dot}
                aria-current={i === index ? 'step' : undefined}
                aria-label={`Step ${i + 1}: ${s.title}`}
                onClick={() => go(i)}
              />
            </li>
          ))}
        </ol>

        {last ? (
          <div className={styles.finish}>
            <Button variant="secondary" href={config.mapUrl}>
              Open the map
            </Button>
            <Button variant="primary" to="/">
              Go to my dashboard
            </Button>
          </div>
        ) : (
          <Button variant="primary" onClick={() => go(index + 1)}>
            Next
          </Button>
        )}
      </footer>
      <p className={styles.keys}>Use the left and right arrow keys to move between steps.</p>
    </div>
  );
}
