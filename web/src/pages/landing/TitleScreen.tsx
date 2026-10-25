/*
 * The title screen that opens the landing page.
 *
 * It sits over the live 3D campus, washed back so the scene reads faintly through
 * it, and there are two ways out that land in the same place:
 *
 *   - Commit: the visitor clicks the action, the overlay fades and the camera flies
 *     into campus.
 *   - Scroll: the visitor just scrolls, the overlay lifts and fades with the scroll
 *     and the page continues into the rest of the landing page.
 *
 * Scroll is never trapped or hijacked. Someone who ignores the title screen
 * entirely gets an ordinary page and never has to click anything.
 */

import { useCallback, useRef, useState, type ReactNode } from 'react';
import { useDepth, type DepthState } from './useDepth';
import styles from './TitleScreen.module.css';

interface Props {
  /** The wordmark, split per character. */
  title: string;
  /** One line under it, split per word. */
  lede: string;
  /** The primary action and anything beside it. */
  children?: ReactNode;
  /** Fired when the visitor commits, so the page can fly the camera in. */
  onCommit?: () => void;
  /**
   * Every frame, with smoothed pointer and scroll. The hero couples this to the
   * real deck.gl camera, which is what makes the parallax true rather than faked.
   */
  onDepthFrame?: (state: DepthState) => void;
  /** Label for the scroll affordance. */
  cue?: string;
  /**
   * False until the scene behind has actually painted. The action waits for it, so
   * committing is never a click that triggers a load: by the time it is live, the
   * flight is a pure camera move over geometry already on screen.
   */
  ready?: boolean;
}

export function TitleScreen({
  title,
  lede,
  children,
  onCommit,
  onDepthFrame,
  cue = 'Scroll to explore',
  ready = true,
}: Props) {
  const [spent, setSpent] = useState(false);
  const spentRef = useRef(false);

  const handleFrame = useCallback(
    (state: DepthState) => {
      onDepthFrame?.(state);
      // Once scrolled past, stop intercepting pointer events entirely. Tracked in a
      // ref as well so this only ever flips state once.
      const done = state.scroll > 0.995;
      if (done !== spentRef.current) {
        spentRef.current = done;
        setSpent(done);
      }
    },
    [onDepthFrame],
  );

  const { hostRef } = useDepth<HTMLDivElement>({ onFrame: handleFrame });

  return (
    <div ref={hostRef} className={[styles.host, spent ? styles.spent : ''].filter(Boolean).join(' ')}>
      <div className={styles.wash} aria-hidden="true" />

      <div className={styles.deck}>
        <h1 className={[styles.plane, styles.planeTitle, styles.title].join(' ')}>
          {title}
        </h1>

        <p className={[styles.plane, styles.planeLede, styles.lede].join(' ')}>
          {lede}
        </p>

        {children && (
          <div
            className={[styles.plane, styles.planeActions, styles.actions, ready ? '' : styles.waiting]
              .filter(Boolean)
              .join(' ')}
            onClick={ready ? onCommit : undefined}
          >
            {children}
          </div>
        )}
      </div>

      <div className={styles.cue}>
        <span className={styles.cueTrack} aria-hidden="true" />
        {cue}
      </div>
    </div>
  );
}
