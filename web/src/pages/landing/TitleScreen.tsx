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

import { useCallback, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
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
}

/**
 * Splits text into per-character spans carrying --char-index, the same shape
 * Splitting.js produces, without the dependency.
 *
 * Accessibility: the visible characters are hidden from assistive tech and the
 * whole string is exposed once on the heading, so a screen reader announces
 * "Flowcast" rather than spelling it out.
 */
function SplitChars({ text }: { text: string }) {
  const chars = useMemo(() => Array.from(text), [text]);
  return (
    <>
      <span className="visually-hidden">{text}</span>
      <span aria-hidden="true" style={{ display: 'flex' }}>
        {chars.map((c, i) => (
          <span key={`${c}-${i}`} className={styles.char} style={{ '--char-index': i } as CSSProperties}>
            {c === ' ' ? ' ' : c}
          </span>
        ))}
      </span>
    </>
  );
}

/** Splits text into per-word spans carrying --word-index. */
function SplitWords({ text }: { text: string }) {
  const words = useMemo(() => text.split(' '), [text]);
  return (
    <>
      <span className="visually-hidden">{text}</span>
      <span aria-hidden="true">
        {words.map((w, i) => (
          <span key={`${w}-${i}`}>
            <span className={styles.word} style={{ '--word-index': i } as CSSProperties}>
              {w}
            </span>
            {i < words.length - 1 && <span className={styles.space} />}
          </span>
        ))}
      </span>
    </>
  );
}

export function TitleScreen({ title, lede, children, onCommit, onDepthFrame, cue = 'Scroll to explore' }: Props) {
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
          <SplitChars text={title} />
        </h1>

        <p className={[styles.plane, styles.planeLede, styles.lede].join(' ')}>
          <SplitWords text={lede} />
        </p>

        {children && (
          <div className={[styles.plane, styles.planeActions, styles.actions].join(' ')} onClick={onCommit}>
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
