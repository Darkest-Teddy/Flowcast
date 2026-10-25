import type { MotionProps, Transition } from 'motion/react';

// Scroll-in reveals for the landing page (Motion). Each plays once, when its block first comes into
// view. The page wraps them in <MotionConfig reducedMotion="user">, so with reduced motion on they
// fade without the rise, and the rules are simply there. Clip-path reveals (unveil, grow) aren't
// transforms, so their callers swap them for `rise` when reduced motion is on.

const ease: Transition = { duration: 0.8, ease: [0.22, 1, 0.36, 1] };

/** One block rising into place: a section's eyebrow, title or lede. */
export const rise: MotionProps = {
  initial: { opacity: 0, y: 28 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, amount: 0.4 },
  transition: ease,
};

/** A list or grid whose items (each given `item`) rise one after another. */
export const stagger: MotionProps = {
  initial: 'hidden',
  whileInView: 'shown',
  viewport: { once: true, amount: 0.15 },
  variants: { hidden: {}, shown: { transition: { staggerChildren: 0.1, delayChildren: 0.05 } } },
};

/** The hero's lines, one after another as the page opens: `stagger`, played on load. */
export const entrance: MotionProps = {
  initial: 'hidden',
  animate: 'shown',
  variants: { hidden: {}, shown: { transition: { staggerChildren: 0.12, delayChildren: 0.1 } } },
};

export const item: MotionProps = {
  variants: { hidden: { opacity: 0, y: 32 }, shown: { opacity: 1, y: 0, transition: ease } },
};

/** A hairline drawing itself across, left to right, as its `item` comes in. */
export const rule: MotionProps = {
  style: { originX: 0 },
  variants: { hidden: { scaleX: 0 }, shown: { scaleX: 1, transition: { duration: 1.1, ease: [0.65, 0, 0.35, 1] } } },
};

/** A picture opening out from a smaller window to its full frame. `radius` is its corner radius in px. */
export const unveil = (radius: number): MotionProps => ({
  initial: { clipPath: `inset(10% 8% 10% 8% round ${radius}px)`, opacity: 0.3 },
  whileInView: { clipPath: `inset(0% 0% 0% 0% round ${radius}px)`, opacity: 1 },
  viewport: { once: true, amount: 0.35 },
  transition: { duration: 1.2, ease: [0.22, 1, 0.36, 1] },
});

/** The preview chart's bars growing up out of its baseline, as a child of a `stagger`. (The clip goes
    on a child: Chromium's IntersectionObserver counts an element's own clip-path, so a fully clipped
    element would never be seen coming into view.) It ends 12px outside the plot so the selected
    bar's ring isn't cut off, and starts 12px below the plot's 208px top (Landing.module.css). */
export const grow: MotionProps = {
  variants: {
    hidden: { clipPath: 'inset(220px -12px -12px -12px)' },
    shown: { clipPath: 'inset(-12px -12px -12px -12px)', transition: { duration: 1, ease: [0.22, 1, 0.36, 1], delay: 0.15 } },
  },
};

/** A block coming into focus as it scrolls in, after Raycast: rising and fading in out of a soft blur. */
export const reveal: MotionProps = {
  initial: { opacity: 0, y: 24, filter: 'blur(8px)' },
  whileInView: { opacity: 1, y: 0, filter: 'blur(0px)' },
  viewport: { once: true, amount: 0.4 },
  transition: ease,
};
