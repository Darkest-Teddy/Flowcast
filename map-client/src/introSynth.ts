// The intro's sounds themselves (introSound.ts plays them): whooshes of air and landing thumps,
// made from filtered noise and a falling sine. Kept apart from the browser glue so they can be
// rendered offline (an OfflineAudioContext) and listened to as a file.
//
// What makes these sound like air and not static: pink noise (white is all hiss), envelopes that
// swell and fade smoothly (exponential ramps from near zero stay silent most of the way, then burst),
// a little room (a short synthetic reverb) and a limiter so overlapping sounds never clip.

/** Where every intro sound goes: `dry` straight out, `wet` through the reverb. */
export interface IntroBus {
  ctx: BaseAudioContext;
  dry: AudioNode;
  wet: AudioNode;
}

const noises = new WeakMap<BaseAudioContext, AudioBuffer>();

/** Two seconds of pink noise (Paul Kellet's filter), shared by every sound on a context. */
function pinkNoise(ctx: BaseAudioContext): AudioBuffer {
  let buffer = noises.get(ctx);
  if (!buffer) {
    buffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0, peak = 0;
    for (let i = 0; i < data.length; i++) {
      const white = Math.random() * 2 - 1;
      b0 = 0.99765 * b0 + white * 0.099046;
      b1 = 0.963 * b1 + white * 0.2965164;
      b2 = 0.57 * b2 + white * 1.0526913;
      data[i] = b0 + b1 + b2 + white * 0.1848;
      peak = Math.max(peak, Math.abs(data[i]));
    }
    for (let i = 0; i < data.length; i++) data[i] /= peak;
    noises.set(ctx, buffer);
  }
  return buffer;
}

/** A dark, short room: decaying stereo noise, smoothed so the tail has no fizz. */
function roomImpulse(ctx: BaseAudioContext, seconds = 1.3): AudioBuffer {
  const length = Math.round(ctx.sampleRate * seconds);
  const impulse = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const data = impulse.getChannelData(c);
    let smooth = 0;
    for (let i = 0; i < length; i++) {
      smooth += 0.2 * (Math.random() * 2 - 1 - smooth);
      data[i] = smooth * Math.exp(-i / ctx.sampleRate / 0.32);
    }
  }
  return impulse;
}

/** The output chain: dry and reverb into a limiter, so stacked whooshes and thumps never clip. */
export function introBus(ctx: BaseAudioContext, destination: AudioNode = ctx.destination): IntroBus {
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -10;
  limiter.knee.value = 6;
  limiter.ratio.value = 12;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.2;
  limiter.connect(destination);
  const dry = ctx.createGain();
  dry.connect(limiter);
  const room = ctx.createConvolver();
  room.buffer = roomImpulse(ctx);
  const wet = ctx.createGain();
  wet.gain.value = 0.9;
  room.connect(wet).connect(limiter);
  return { ctx, dry, wet: room };
}

/** A swell: up from silence to 1 at `peak` (0..1 of the way), back down to silence, smoothly. */
function swell(peak: number, points = 128): Float32Array {
  const curve = new Float32Array(points);
  for (let i = 0; i < points; i++) {
    const x = i / (points - 1);
    curve[i] = x < peak ? Math.sin((Math.PI / 2) * (x / peak)) ** 2 : Math.cos((Math.PI / 2) * ((x - peak) / (1 - peak))) ** 2;
  }
  return curve;
}

/**
 * Air rushing by, starting `at` (context time): pink noise through a band whose centre sweeps
 * through `hz` (two or more points, spread evenly over the sound), swelling to `gain` and dying
 * away, panned across from `pan` to `-pan`.
 */
function whoosh(bus: IntroBus, at: number, ms: number, hz: number[], { gain = 0.5, pan = 0.4, peak = 0.55, room = 0.35 } = {}) {
  const { ctx } = bus;
  const end = at + ms / 1000;
  const source = ctx.createBufferSource();
  source.buffer = pinkNoise(ctx);
  source.loop = true;
  // No rumble below the band, and no hiss far above it.
  const low = ctx.createBiquadFilter();
  low.type = 'highpass';
  low.frequency.value = 120;
  const band = ctx.createBiquadFilter();
  band.type = 'bandpass';
  band.Q.value = 0.6;
  const top = ctx.createBiquadFilter();
  top.type = 'lowpass';
  top.Q.value = 0.5;
  band.frequency.setValueAtTime(hz[0], at);
  top.frequency.setValueAtTime(hz[0] * 2.5, at);
  hz.slice(1).forEach((f, i) => {
    const t = at + ((end - at) * (i + 1)) / (hz.length - 1);
    band.frequency.exponentialRampToValueAtTime(f, t);
    top.frequency.exponentialRampToValueAtTime(f * 2.5, t);
  });
  const level = ctx.createGain();
  level.gain.value = 0;
  const shape = swell(peak).map((v) => v * gain);
  level.gain.setValueCurveAtTime(shape, at, end - at);
  const panner = ctx.createStereoPanner();
  panner.pan.setValueAtTime(pan, at);
  panner.pan.linearRampToValueAtTime(-pan, end);
  const send = ctx.createGain();
  send.gain.value = room;
  source.connect(low).connect(band).connect(top).connect(level).connect(panner);
  panner.connect(bus.dry);
  panner.connect(send).connect(bus.wet);
  // Somewhere different in the noise each time, so repeated whooshes aren't identical.
  source.start(at, Math.random() * 1.5);
  source.stop(end + 0.05);
}

/**
 * A landing thump `at` (context time): a sine falling from ~150 Hz, softly overdriven so small
 * speakers (which can't play the fundamental) still carry it as harmonics, under a short muffled
 * whump of noise.
 */
function thump(bus: IntroBus, at: number, { gain = 0.5, room = 0.25 } = {}) {
  const { ctx } = bus;
  const body = ctx.createOscillator();
  body.type = 'sine';
  body.frequency.setValueAtTime(150, at);
  body.frequency.exponentialRampToValueAtTime(48, at + 0.3);
  const drive = ctx.createWaveShaper();
  const bend = new Float32Array(1025);
  for (let i = 0; i < bend.length; i++) bend[i] = Math.tanh(2.5 * ((i / 512) - 1)) / Math.tanh(2.5);
  drive.curve = bend;
  const bodyLevel = ctx.createGain();
  bodyLevel.gain.setValueAtTime(0, at);
  bodyLevel.gain.linearRampToValueAtTime(gain, at + 0.006); // a few ms in, so it doesn't click
  bodyLevel.gain.setTargetAtTime(0, at + 0.006, 0.11);
  const whump = ctx.createBufferSource();
  whump.buffer = pinkNoise(ctx);
  const muffle = ctx.createBiquadFilter();
  muffle.type = 'lowpass';
  muffle.frequency.value = 380;
  const whumpLevel = ctx.createGain();
  whumpLevel.gain.setValueAtTime(0, at);
  whumpLevel.gain.linearRampToValueAtTime(gain * 0.7, at + 0.004);
  whumpLevel.gain.setTargetAtTime(0, at + 0.004, 0.035);
  const out = ctx.createGain();
  const send = ctx.createGain();
  send.gain.value = room;
  body.connect(drive).connect(bodyLevel).connect(out);
  whump.connect(muffle).connect(whumpLevel).connect(out);
  out.connect(bus.dry);
  out.connect(send).connect(bus.wet);
  body.start(at);
  body.stop(at + 0.8);
  whump.start(at, Math.random() * 1.5);
  whump.stop(at + 0.3);
}

/** The intro's moments (App.tsx, INTRO_DROPS), each starting `at` (context time). */
export const introMoments = {
  /** The clouds rushing past, as the first drop starts. */
  clouds: (bus: IntroBus, at: number, ms: number) => whoosh(bus, at, ms, [2200, 380], { gain: 1.1, pan: 0.5, peak: 0.4 }),
  /** One drop: air rushing up past the camera (unless the clouds' whoosh already is), then the landing. */
  drop: (bus: IntroBus, at: number, ms: number, air = true) => {
    if (air) whoosh(bus, at, ms, [1300, 240], { gain: 1.0, pan: 0.25, peak: 0.6 });
    thump(bus, at + (ms / 1000) * 0.85, { gain: 0.32 });
  },
  /** The swoop into the view: up and over, then settling. */
  swoop: (bus: IntroBus, at: number, ms: number) => whoosh(bus, at, ms, [320, 1600, 420], { gain: 1.2, pan: 0.5, peak: 0.45, room: 0.5 }),
};
