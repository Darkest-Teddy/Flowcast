/*
 * /join -- build a character and put yourself on the campus map.
 *
 * A phone flow in four screens: Customize -> Your details -> Confirm -> "You're on the map". The
 * character is assembled live from the same Kenney models the map draws (see lib/personaRender.ts
 * and @map/persona/parts), so what you build is what walks around.
 *
 * Every 3D surface on this page -- the big stage, the mini card, the confirm and status previews, and
 * every option thumbnail in the sheet -- is a *view* of one shared WebGL context. That is not an
 * optimisation; a context per thumbnail would exceed the browser's limit as soon as a category has
 * ten options.
 *
 * Reduced motion is honoured throughout: the stage stops spinning, the characters settle into a pose
 * instead of looping, and picking an option no longer plays the nod or buzzes the phone.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  CATEGORIES,
  DEFAULT_APPEARANCE,
  MODELS,
  PALETTE,
  describe,
  type Appearance,
  type ColorField,
  type ColorId,
  type StyleField,
} from '@map/persona/parts';
import {
  DEFAULT_LOCATION_ID,
  LOCATIONS,
  isWalking,
  locationName,
  myPersonaId,
  readPersonas,
  removePersona,
  savePersona,
  setMyPersonaId,
  statusText,
  type Persona,
} from '../lib/personaShared';
import { createPersonaRenderer, type PersonaRenderer, type ViewSpec } from '../lib/personaRender';
import styles from './Join.module.css';

/* ---------------------------------------------------------------------------
 * The shared renderer
 * ------------------------------------------------------------------------- */

const DARK_THEME = { ground: '#2c2c2e', shadow: '#151517', outline: '#0b0b0d' };
const LIGHT_THEME = { ground: '#e6e6eb', shadow: '#cfcfd6', outline: '#1d1d1f' };

/** The same rule tokens.css uses: an explicit data-theme wins, otherwise follow the system. */
function isDarkNow(): boolean {
  const attr = document.documentElement.dataset.theme;
  if (attr === 'dark') return true;
  if (attr === 'light') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

function usePersonaRenderer(reducedMotion: boolean): PersonaRenderer | null {
  const [renderer, setRenderer] = useState<PersonaRenderer | null>(null);

  useEffect(() => {
    let live = true;
    let made: PersonaRenderer | null = null;
    createPersonaRenderer()
      .then((r) => {
        if (!live) return void r.dispose();
        made = r;
        void r.preload(MODELS);
        r.setHeadShape(3); // "soft": the handoff's default
        r.setOutline(3);
        r.setTheme(isDarkNow() ? DARK_THEME : LIGHT_THEME);
        setRenderer(r);
      })
      .catch((err: unknown) => console.error('[persona] renderer failed', err));
    return () => {
      live = false;
      made?.dispose();
    };
  }, []);

  useEffect(() => {
    renderer?.setReducedMotion(reducedMotion);
  }, [renderer, reducedMotion]);

  // Follow the appearance setting while the page is open.
  useEffect(() => {
    if (!renderer) return;
    const apply = () => renderer.setTheme(isDarkNow() ? DARK_THEME : LIGHT_THEME);
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', apply);
    const observer = new MutationObserver(apply);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => {
      mq.removeEventListener('change', apply);
      observer.disconnect();
    };
  }, [renderer]);

  return renderer;
}

/* ---------------------------------------------------------------------------
 * One canvas showing one character
 * ------------------------------------------------------------------------- */

interface PersonaViewProps {
  renderer: PersonaRenderer | null;
  spec: ViewSpec;
  className?: string;
  style?: CSSProperties;
  /** Set for the big preview, so a pick can play the nod on it. */
  viewRef?: React.RefObject<HTMLCanvasElement | null>;
}

function PersonaView({ renderer, spec, className, style, viewRef }: PersonaViewProps) {
  const own = useRef<HTMLCanvasElement>(null);
  const ref = viewRef ?? own;

  /*
   * Re-attached on every render rather than under a dependency list. attach() diffs the look by its
   * appearance key and only rebuilds when it actually changed, so this is cheap, and it keeps the
   * view's spec in step without having to enumerate every field of it as a dependency.
   */
  useEffect(() => {
    if (ref.current && renderer) renderer.attach(ref.current, spec);
  });

  useEffect(() => {
    const canvas = ref.current;
    return () => {
      if (canvas && renderer) renderer.detach(canvas);
    };
  }, [renderer, ref]);

  return <canvas ref={ref} className={className} style={style} />;
}

/* ---------------------------------------------------------------------------
 * Appearance edits
 * ------------------------------------------------------------------------- */

function withStyle(a: Appearance, field: StyleField, id: string): Appearance {
  return { ...a, [field]: id };
}
function withColor(a: Appearance, field: ColorField, id: ColorId): Appearance {
  return { ...a, [field]: id };
}

const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(Math.random() * arr.length)];

/** A random look. Accessories are left off more often than on, or everyone ends up festooned. */
function randomAppearance(): Appearance {
  let next: Appearance = { ...DEFAULT_APPEARANCE };
  for (const c of CATEGORIES) {
    next = withStyle(next, c.field, pick(c.options).id);
    if (c.color && c.colors) next = withColor(next, c.color, pick(c.colors));
  }
  if (Math.random() < 0.5) next = withStyle(next, 'hat', 'hat-none');
  if (Math.random() < 0.5) next = withStyle(next, 'glasses', 'glasses-none');
  if (Math.random() < 0.5) next = withStyle(next, 'bag', 'bag-none');
  if (Math.random() < 0.6) next = withStyle(next, 'hand', 'hand-none');
  return next;
}

const PROGRESS_STEPS = ['customize', 'details', 'confirm'] as const;
type Step = (typeof PROGRESS_STEPS)[number] | 'status';

function Progress({ step }: { step: Step }) {
  const at = PROGRESS_STEPS.indexOf(step as (typeof PROGRESS_STEPS)[number]);
  return (
    <div className={styles.progress} role="progressbar" aria-valuemin={1} aria-valuemax={3} aria-valuenow={at + 1} aria-label="Step">
      {PROGRESS_STEPS.map((id, i) => (
        <span key={id} className={styles.progressSegment} data-on={i <= at || undefined} />
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * The page
 * ------------------------------------------------------------------------- */

export default function Join() {
  const reducedMotion = usePrefersReducedMotion();
  const renderer = usePersonaRenderer(reducedMotion);

  const [step, setStep] = useState<Step>('customize');
  const [tab, setTab] = useState(CATEGORIES[0].id);
  const [app, setApp] = useState<Appearance>(() => ({ ...DEFAULT_APPEARANCE }));
  const [name, setName] = useState('');
  const [bio, setBio] = useState('');
  const [home, setHome] = useState(DEFAULT_LOCATION_ID);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [persona, setPersona] = useState<Persona | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const stageRef = useRef<HTMLCanvasElement>(null);
  const emoteTimer = useRef<number | undefined>(undefined);

  // A revisit from the same phone lands straight on the status screen.
  useEffect(() => {
    const mine = myPersonaId();
    if (!mine) return;
    const found = readPersonas().find((p) => p.id === mine);
    if (!found) return void setMyPersonaId(null);
    setPersona(found);
    setApp(found.appearance);
    setName(found.name);
    setBio(found.bio);
    setHome(found.homeLocationId);
    setStep('status');
  }, []);

  // The status line is a clock reading; nothing else on the page needs a tick.
  useEffect(() => {
    if (step !== 'status') return;
    const id = window.setInterval(() => setNow(Date.now()), 2000);
    return () => window.clearInterval(id);
  }, [step]);

  useEffect(() => () => window.clearTimeout(emoteTimer.current), []);

  /** Every pick: the card pops, the phone buzzes, and the character nods. All three stand down under reduced motion. */
  const feedback = useCallback(
    (el?: HTMLElement | null) => {
      if (reducedMotion) return;
      el?.animate?.(
        [{ transform: 'scale(1)' }, { transform: 'scale(0.9)' }, { transform: 'scale(1.05)' }, { transform: 'scale(1)' }],
        { duration: 320, easing: 'cubic-bezier(.3,.7,.4,1)' },
      );
      try {
        navigator.vibrate?.(8);
      } catch {
        // Not every browser allows it, and it is decoration either way.
      }
      window.clearTimeout(emoteTimer.current);
      // A beat after the pick, so the rebuilt character is in place to nod.
      emoteTimer.current = window.setTimeout(() => {
        if (stageRef.current) renderer?.emote(stageRef.current, 'emote-yes');
      }, 60);
    },
    [reducedMotion, renderer],
  );

  const category = useMemo(() => CATEGORIES.find((c) => c.id === tab) ?? CATEGORIES[0], [tab]);

  const chooseStyle = (field: StyleField, id: string, el: HTMLElement | null) => {
    setApp((a) => withStyle(a, field, id));
    feedback(el);
  };
  const chooseColor = (field: ColorField, id: ColorId, el: HTMLElement | null) => {
    setApp((a) => withColor(a, field, id));
    feedback(el);
  };

  const submit = () => {
    setSubmitting(true);
    // A beat of "Adding you to the map…" so the transition reads as an action, not a jump cut.
    window.setTimeout(() => {
      const saved = savePersona({ name: name.trim(), bio: bio.trim(), appearance: { ...app }, homeLocationId: home });
      setMyPersonaId(saved.id);
      setPersona(saved);
      setSubmitting(false);
      setNow(Date.now());
      setStep('status');
    }, 700);
  };

  const remove = () => {
    if (!persona) return;
    setRemoving(true);
    window.setTimeout(() => {
      removePersona(persona.id);
      setMyPersonaId(null);
      setPersona(null);
      setApp({ ...DEFAULT_APPEARANCE });
      setName('');
      setBio('');
      setHome(DEFAULT_LOCATION_ID);
      setTab(CATEGORIES[0].id);
      setError(null);
      setRemoving(false);
      setStep('customize');
    }, 500);
  };

  /* ---------------- Step 1: Customize ---------------- */
  if (step === 'customize') {
    return (
      <div className={styles.screen}>
        <div className={styles.stage}>
          <PersonaView
            renderer={renderer}
            viewRef={stageRef}
            className={styles.stageCanvas}
            spec={{ app, cam: 'stage', auto: true, drag: true, ground: true, anim: 'loop' }}
          />
          <div className={styles.stageOverlay}>
            <Progress step="customize" />
            <div className={styles.headRow}>
              <div className={styles.headText}>
                <p className={styles.eyebrow}>Step 1 of 3 · Customize</p>
                <h1 className={styles.title}>Build your character</h1>
              </div>
              <button
                type="button"
                className={styles.iconButton}
                aria-label="Randomize"
                onClick={(e) => {
                  setApp(randomAppearance());
                  feedback(e.currentTarget);
                }}
              >
                <svg width={18} height={18} viewBox="0 0 14 14" fill="none" aria-hidden="true">
                  <path
                    d="M1 3.5h2.5c1.6 0 2.6.8 3.4 2.3l1.2 2.4c.8 1.5 1.8 2.3 3.4 2.3H13M1 10.5h2.5c1 0 1.7-.3 2.3-.9M8.2 4.4c.6-.6 1.3-.9 2.3-.9H13M11 1.5l2 2-2 2M11 8.5l2 2-2 2"
                    stroke="currentColor"
                    strokeWidth={1.3}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            </div>
          </div>
          <span className={styles.dragHint}>Drag to turn</span>
        </div>

        <div className={styles.sheet}>
          <div className={styles.tabs} role="tablist" aria-label="Part of the character">
            {CATEGORIES.map((c) => (
              <button
                key={c.id}
                type="button"
                role="tab"
                aria-selected={c.id === tab}
                className={styles.tab}
                onClick={() => setTab(c.id)}
              >
                {c.label}
              </button>
            ))}
          </div>

          <div className={styles.cards}>
            {category.options.map((o) => {
              const on = app[category.field] === o.id;
              // A hat would hide the hair the thumbnail is there to show.
              const thumb: Appearance = category.id === 'hair' ? withStyle(withStyle(app, category.field, o.id), 'hat', 'hat-none') : withStyle(app, category.field, o.id);
              return (
                <button
                  key={o.id}
                  type="button"
                  className={styles.card}
                  aria-pressed={on}
                  data-on={on || undefined}
                  onClick={(e) => chooseStyle(category.field, o.id, e.currentTarget)}
                >
                  <PersonaView renderer={renderer} className={styles.cardCanvas} spec={{ app: thumb, cam: category.cam, anim: 'pose' }} />
                  <span className={styles.cardLabel}>{o.label}</span>
                  {on && (
                    <span className={styles.cardCheck} aria-hidden="true">
                      <svg width={10} height={10} viewBox="0 0 10 10" fill="none">
                        <path d="M2 5.2l2 2L8 3" stroke="#fff" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {/* A fixed slot, so the sheet does not jump between a category with colours and one without. */}
          <div className={styles.colorSlot}>
            {category.color && category.colors && (
              <>
                <span className={styles.colorTitle}>{category.label} colour</span>
                <div className={styles.swatches} role="radiogroup" aria-label={`${category.label} colour`}>
                  {category.colors.map((id) => {
                    const c = PALETTE.find((x) => x.id === id);
                    const on = app[category.color!] === id;
                    return (
                      <button
                        key={id}
                        type="button"
                        role="radio"
                        aria-checked={on}
                        aria-label={c?.label ?? id}
                        className={styles.swatchHit}
                        onClick={(e) => chooseColor(category.color!, id, e.currentTarget)}
                      >
                        <span className={styles.swatch} data-on={on || undefined} style={{ background: c?.hex }} />
                      </button>
                    );
                  })}
                </div>
              </>
            )}
          </div>

          <button type="button" className={styles.primary} onClick={() => { setStep('details'); setError(null); }}>
            Next →
          </button>
        </div>
      </div>
    );
  }

  /* ---------------- Step 2: Your details ---------------- */
  if (step === 'details') {
    return (
      <div className={styles.form}>
        <Progress step="details" />
        <div className={styles.formHead}>
          <div className={styles.headText}>
            <p className={styles.eyebrow}>Step 2 of 3 · Your details</p>
            <h1 className={styles.title}>Who are you?</h1>
          </div>
          <div className={styles.miniCard}>
            <PersonaView renderer={renderer} className={styles.miniCanvas} spec={{ app, cam: 'full', anim: 'loop' }} />
          </div>
        </div>

        <label className={styles.field}>
          <span className={styles.fieldLabel}>Name</span>
          <input
            className={styles.input}
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={24}
            autoComplete="nickname"
            aria-invalid={error ? true : undefined}
          />
        </label>

        <label className={styles.field}>
          <span className={styles.fieldLabel}>A little about you</span>
          <textarea className={styles.textarea} value={bio} onChange={(e) => setBio(e.target.value)} maxLength={140} rows={2} />
          <span className={styles.hint}>Optional, shown with your character</span>
        </label>

        <label className={styles.field}>
          <span className={styles.fieldLabel}>Where do you hang out?</span>
          <select className={styles.select} value={home} onChange={(e) => setHome(e.target.value)}>
            {LOCATIONS.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </label>

        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}

        <div className={styles.footer}>
          <button type="button" className={styles.secondary} onClick={() => { setStep('customize'); setError(null); }}>
            ← Back
          </button>
          <button
            type="button"
            className={`${styles.primary} ${styles.grow}`}
            onClick={() => {
              if (!name.trim()) return setError('Give your character a name.');
              setError(null);
              setStep('confirm');
            }}
          >
            Next →
          </button>
        </div>
      </div>
    );
  }

  /* ---------------- Step 3: Confirm ---------------- */
  if (step === 'confirm') {
    return (
      <div className={styles.form}>
        <Progress step="confirm" />
        <div className={styles.headText}>
          <p className={styles.eyebrow}>Step 3 of 3 · Confirm</p>
          <h1 className={styles.title}>Ready to join?</h1>
        </div>

        <div className={styles.preview}>
          <PersonaView renderer={renderer} className={styles.previewCanvas} spec={{ app, cam: 'full', auto: true, drag: true, ground: true, anim: 'loop' }} />
        </div>

        <div className={styles.summary}>
          <p className={styles.personaName}>{name}</p>
          {bio && <p className={styles.personaBio}>{bio}</p>}
          <p className={styles.personaOutfit}>
            Hangs out at {locationName(home)} · {describe(app)}
          </p>
        </div>

        <div className={styles.footer}>
          <button type="button" className={styles.secondary} disabled={submitting} onClick={() => setStep('details')}>
            ← Back
          </button>
          <button type="button" className={`${styles.primary} ${styles.grow}`} disabled={submitting} data-busy={submitting || undefined} onClick={submit}>
            {submitting ? 'Adding you to the map…' : 'Add me to the map'}
          </button>
        </div>
      </div>
    );
  }

  /* ---------------- Status ---------------- */
  const walking = persona ? isWalking(persona, now) : false;
  return (
    <div className={styles.form}>
      <h1 className={`${styles.title} ${styles.statusTitle}`}>You&rsquo;re on the map</h1>

      <div className={styles.preview}>
        <PersonaView
          renderer={renderer}
          className={styles.previewCanvas}
          spec={{
            app: persona?.appearance ?? app,
            cam: 'full',
            // It spins while it idles; while it is walking across campus, it just walks.
            auto: !walking,
            drag: true,
            ground: true,
            anim: walking ? 'walk' : 'loop',
          }}
        />
      </div>

      <div className={styles.summary}>
        <p className={styles.personaName}>{persona?.name ?? name}</p>
        {(persona?.bio || bio) && <p className={styles.personaBio}>{persona?.bio ?? bio}</p>}
      </div>

      <div className={styles.rightNow}>
        <span className={styles.rightNowLabel}>Right now</span>
        <div className={styles.rightNowValue}>
          <span className={styles.okDot} aria-hidden="true" />
          <p>{persona ? statusText(persona, now) : 'Finding your character…'}</p>
        </div>
      </div>

      <button type="button" className={`${styles.secondary} ${styles.removeButton}`} disabled={removing} onClick={remove}>
        {removing ? 'Removing…' : 'Remove my character'}
      </button>
    </div>
  );
}
