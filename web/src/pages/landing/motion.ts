import type { MotionProps, Transition } from 'motion/react';

// Scroll-in reveals for the landing page (Motion). Each plays once, when its block first comes into
// view. The page wraps them in <MotionConfig reducedMotion="user">, so with reduced motion on they
// fade without the rise.

const ease: Transition = { duration: 0.7, ease: [0.22, 1, 0.36, 1] };

/** One block rising into place: a section's eyebrow, title or lede. */
export const rise: MotionProps = {
  initial: { opacity: 0, y: 24 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, amount: 0.4 },
  transition: ease,
};

/** A list or grid whose items (each given `item`) rise one after another. */
export const stagger: MotionProps = {
  initial: 'hidden',
  whileInView: 'shown',
  viewport: { once: true, amount: 0.15 },
  variants: { hidden: {}, shown: { transition: { staggerChildren: 0.09 } } },
};

export const item: MotionProps = {
  variants: { hidden: { opacity: 0, y: 32 }, shown: { opacity: 1, y: 0, transition: ease } },
};
