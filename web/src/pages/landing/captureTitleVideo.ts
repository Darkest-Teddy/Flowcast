/*
 * Records the title screen's background from the live renderer.
 *
 * Why this exists: the title screen must paint instantly and stay smooth, and the
 * real renderer can do neither on a modest GPU. So the backdrop is a recording of
 * the real scene, and the renderer warms up invisibly behind it.
 *
 * Two things make the handoff from video to live canvas invisible:
 *
 *   1. Capture mode holds the camera perfectly still, so every frame of the file
 *      shares the exact camera the live scene opens on.
 *   2. The recording is made at a reduced simulation speed and played back faster.
 *      A machine that renders at 9fps cannot record smooth footage in real time,
 *      but it can gather real frames over a longer wall clock; played back at
 *      CAPTURE_PLAYBACK_RATE the motion is correct and the frame rate is that much
 *      higher.
 *
 * Dev-only. Run it from the console on /?capture=1 and the file is written into
 * map-client/public/video by the captureSink plugin in vite.config.ts.
 */

import { CAPTURE_PLAYBACK_RATE } from './HeroScene';

export interface CaptureOptions {
  /** Seconds of wall clock to record. Playback is this / CAPTURE_PLAYBACK_RATE. */
  seconds?: number;
  /** Filename written under map-client/public/video. */
  name?: string;
  /** Video bitrate. The scene is dark and mostly still, so this goes a long way. */
  bitsPerSecond?: number;
}

export async function captureTitleVideo(
  canvas: HTMLCanvasElement,
  { seconds = 30, name = 'title-campus.webm', bitsPerSecond = 6_000_000 }: CaptureOptions = {},
): Promise<string> {
  if (typeof MediaRecorder === 'undefined') throw new Error('MediaRecorder is not available');

  // captureStream(0) would require driving frames by hand; a frame rate here lets
  // the recorder take whatever the renderer actually paints, which is the point.
  const stream = canvas.captureStream(30);

  const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((t) =>
    MediaRecorder.isTypeSupported(t),
  );
  if (!mime) throw new Error('no supported webm codec');

  const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: bitsPerSecond });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size) chunks.push(e.data);
  };

  const done = new Promise<Blob>((resolve) => {
    recorder.onstop = () => resolve(new Blob(chunks, { type: mime }));
  });

  recorder.start(1000);
  await new Promise((r) => setTimeout(r, seconds * 1000));
  recorder.stop();
  stream.getTracks().forEach((t) => t.stop());

  const blob = await done;
  const res = await fetch(`/__capture?name=${encodeURIComponent(name)}`, { method: 'POST', body: blob });
  const written = await res.text();
  if (!res.ok) throw new Error(`capture sink refused: ${written}`);

  const playbackSeconds = seconds / CAPTURE_PLAYBACK_RATE;
  return `wrote video/${name} (${written}); plays back in ~${playbackSeconds.toFixed(0)}s at ${CAPTURE_PLAYBACK_RATE}x`;
}
