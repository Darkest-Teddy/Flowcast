// Sound for the intro's drop from the sky (App.tsx, INTRO_DROPS), in the spirit of GTA V's
// character switch, from two recordings in public/intro/. zoom-in.mp3 (13 s) is three deep zoom-in
// booms, the last running on into a long rumble. Each of the camera's moves gets one: a boom for
// each drop, and the last boom with its rumble for the swoop into the view. The booms are 2.75 s
// apart in the file and the moves 0.57 s, so each is cut from the decoded file as it plays (Web
// Audio). arrive.mp3 (1.6 s) is a short four-note chime that ends it, scheduled on the same clock
// as the swoop's boom so it comes in exactly as the rumble fades.
//
// The sound is on by default; the loading screen's speaker button turns it off (remembered here).
// Browsers only let a page make sound after a click or key press on it, but in Chromium-based
// browsers the landing page's "Open the map" click carries over to the map page, so the audio
// starts on its own. That's why the landing page doesn't prerender the map: a page loaded before
// the click never gets to play in Chromium. Brave's or Safari's stricter rules, or a map opened
// directly, still hold it back; then the audio starts on the first press on the page, and a boom that comes
// while it's still held back is skipped, not played late over the map (and so is the chime, with
// the swoop's). Both files are fetched and decoded while the map loads, so the first boom is ready
// on time. Off with reduced motion.
//
// The booms are one sequence: the first decides whether the intro has sound, so a browser that lets the
// audio start partway through (a press during the drop, or a late resume) never starts it on a later boom,
// out of step with the camera. Before the drop the intro waits briefly for the audio to be running and
// the files decoded (introSound.ready), so the first boom isn't lost to an audio clock still starting up.
//
// The join card's tone (public/sounds/text-tone.mp3, 0.65 s) shares the same audio, mute and rules: it
// plays as the card opens (JoinQrCard.tsx), and is skipped while the browser holds sound back. It also
// holds off from the loading screen until the intro's chime has ended, so it never lands in the drop.

const MUTE_KEY = 'flowcast.sound';
const ZOOM = '/intro/zoom-in.mp3';
const ARRIVE = '/intro/arrive.mp3';
const JOIN_TONE = '/sounds/text-tone.mp3';

/**
 * Where each boom starts in the file, in seconds: one per drop, then the swoop's. Measured with
 * ffmpeg (onsets at 1.05, 3.81 and 6.51 s) and taken a little early, since browsers may trim the
 * mp3's leading silence differently. Each drop's boom plays until the next one starts.
 */
const BOOMS = [1.0, 3.76, 6.46];

/**
 * Where the swoop's rumble has faded, in seconds into zoom-in.mp3: its body ends there, dropping
 * 10 dB in a tenth of a second to 25 dB under the boom, and the 2.4 s left of it is quieter still,
 * so the chime comes in there rather than after the file's last, silent samples.
 */
const RUMBLE_FADED = 10.4;
/** The chime's first note, in seconds into arrive.mp3 (after a faint lead-in): it lands on RUMBLE_FADED. */
const ARRIVE_NOTE = 0.32;

export function soundMuted(): boolean {
  try {
    return localStorage.getItem(MUTE_KEY) === 'off';
  } catch {
    return false;
  }
}

export function setSoundMuted(muted: boolean) {
  try {
    if (muted) localStorage.setItem(MUTE_KEY, 'off');
    else localStorage.removeItem(MUTE_KEY);
  } catch {
    // storage blocked: muted for this visit only
  }
  if (muted) void context?.suspend();
  else void audio()?.resume(); // the button press itself lets it start
}

/** Whether the intro has sound: on unless muted or under reduced motion (the browser may still be holding it back). */
export function soundOn(): boolean {
  return !quiet();
}

const quiet = () => soundMuted() || window.matchMedia('(prefers-reduced-motion: reduce)').matches;

let context: AudioContext | null = null;
const bytes = new Map<string, Promise<ArrayBuffer>>();
const recordings = new Map<string, AudioBuffer>();
/** The files' decoding, started with the audio context. */
let decoding: Promise<unknown> = Promise.resolve();
/** Whether this intro's booms are playing: decided by the first drop's. */
let booming = false;
/** Until when (audio clock, seconds) the join card's tone waits: the intro's, from the loading screen to its chime's end. */
let joinHeldUntil = 0;
/** When the swoop's chime ends (audio clock), once it's scheduled. */
let chimeEnds = 0;

/** A file's bytes, fetched once (allowed while prerendered, unlike starting the audio). */
function load(file: string): Promise<ArrayBuffer> {
  let data = bytes.get(file);
  if (!data) {
    data = fetch(file).then((res) => (res.ok ? res.arrayBuffer() : Promise.reject(new Error(`${file}: ${res.status}`))));
    bytes.set(file, data);
  }
  return data;
}

/** The audio context, made on first use (once a prerendered page is shown: see introSound.prepare). */
function audio(): AudioContext | null {
  if (quiet() || typeof AudioContext === 'undefined') return null;
  if (!context) {
    const ctx = new AudioContext();
    context = ctx;
    // Decoding works while the browser holds the audio back, so the files are ready either way.
    // One that can't be had is left out.
    decoding = Promise.all([ZOOM, ARRIVE, JOIN_TONE].map((file) => load(file).then((data) => ctx.decodeAudioData(data)).then((buffer) => { recordings.set(file, buffer); }, () => {})));
    // Again when the page is shown (back from the back/forward cache, or a tab coming forward), in
    // case the browser lets it start then, and on the first press on the page, which always does.
    const wake = () => {
      if (!quiet() && document.visibilityState === 'visible') void context?.resume();
    };
    window.addEventListener('pageshow', wake);
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('pointerdown', wake, { once: true });
    window.addEventListener('keydown', wake, { once: true });
  }
  if (context.state === 'suspended') void context.resume();
  return context;
}

// Dev handle for checking from the console whether the browser let the intro's audio run.
if (import.meta.env.DEV) Object.assign(window, { __flowcastSound: { state: () => context?.state ?? 'not made', muted: soundMuted, loaded: () => [...recordings.keys()] } });

/** The intro's sounds, one per move of the camera. */
export const introSound = {
  /** Fetches the files and starts the audio as early as possible: as the loading screen shows (a prerendered page, once it's shown). */
  prepare: () => {
    if (quiet()) return;
    joinHeldUntil = Infinity;
    for (const file of [ZOOM, ARRIVE]) void load(file).catch(() => {});
    if (!(document as Document & { prerendering?: boolean }).prerendering) return void audio();
    document.addEventListener('prerenderingchange', () => void audio(), { once: true });
  },
  /**
   * Resolves once the audio is running and the files are decoded, or after `ms` regardless (the
   * browser may be holding the audio back until a press on the page). Asks it to start, too.
   */
  ready: (ms: number): Promise<void> => {
    const ctx = audio();
    if (!ctx) return Promise.resolve();
    return Promise.race([Promise.all([ctx.resume(), decoding]), new Promise((resolve) => setTimeout(resolve, ms))]).then(() => {}, () => {});
  },
  /** Drop `i` (INTRO_DROPS): its boom, as the camera starts down. The first decides whether the rest play. */
  drop: (i: number) => {
    if (i >= BOOMS.length - 1 || (i > 0 && !booming)) return;
    const played = play(ZOOM, BOOMS[i], BOOMS[i + 1]);
    if (i === 0) booming = played;
  },
  /**
   * The swoop into the view: the last boom, its rumble running on past the landing to the file's
   * end, and the chime as the rumble fades (about 3 s after the landing).
   */
  swoop: () => {
    if (!booming) return;
    const at = context?.currentTime ?? 0;
    const boom = BOOMS[BOOMS.length - 1];
    const chime = at + RUMBLE_FADED - boom - ARRIVE_NOTE;
    if (play(ZOOM, boom, undefined, at) && play(ARRIVE, 0, undefined, chime)) chimeEnds = chime + (recordings.get(ARRIVE)?.duration ?? 0);
  },
  /** The intro is over (landed, stopped or skipped): the join card's tone may play once the chime has ended. */
  end: () => {
    joinHeldUntil = chimeEnds;
  },
};

/** The join card opening (JoinQrCard.tsx): a short text tone. */
export function joinTone() {
  if ((context?.currentTime ?? 0) < joinHeldUntil) return;
  play(JOIN_TONE, 0);
}

/** Plays a file from `from` to `to` (seconds), at `at` on the audio clock (now, by default), if the browser is letting it. */
function play(file: string, from: number, to?: number, at = 0): boolean {
  const ctx = audio();
  const recording = recordings.get(file);
  if (!ctx || ctx.state !== 'running' || !recording) return false;
  const source = ctx.createBufferSource();
  source.buffer = recording;
  source.connect(ctx.destination);
  source.start(at, from, (to ?? recording.duration) - from);
  return true;
}
