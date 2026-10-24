// Paste into the development map's console, then await profileFrames({ duration: 30000 }).
// Keep the tab foregrounded and use the same camera, time, quality and viewport for comparisons.
window.profileFrames = async function profileFrames({ duration = 30000, warmup = 3000 } = {}) {
  const app = window.__flowcast;
  if (!app) throw new Error('Open the development map and wait for it to finish loading');
  await new Promise(resolve => setTimeout(resolve, warmup));
  const samples = [];
  const viewport = [innerWidth, innerHeight, devicePixelRatio];
  const camera = app.basemap.getCamera();
  const startTime = app.time;
  let interrupted = false;
  const visibility = () => { interrupted = true; };
  document.addEventListener('visibilitychange', visibility);
  const start = performance.now();
  try {
    await new Promise(resolve => {
      let last;
      function sample(now) {
        if (last !== undefined) samples.push(now - last);
        last = now;
        if (now - start < duration) requestAnimationFrame(sample);
        else resolve();
      }
      requestAnimationFrame(sample);
    });
  } finally {
    document.removeEventListener('visibilitychange', visibility);
  }
  const sorted = [...samples].sort((a, b) => b - a);
  const worst = sorted.slice(0, Math.max(1, Math.ceil(sorted.length * 0.01)));
  const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
  const result = {
    durationMs: performance.now() - start,
    frames: samples.length,
    fps: 1000 / mean(samples),
    low1: 1000 / mean(worst),
    p95Ms: sorted[Math.floor(sorted.length * 0.05)],
    worstMs: sorted[0],
    viewport,
    camera,
    startTime,
    endTime: app.time,
    quality: app.quality.mode,
    basemap: app.basemap.kind,
    trips: app.playback.data.trips.length,
    interrupted: interrupted || document.visibilityState !== 'visible'
      || viewport.some((value, index) => value !== [innerWidth, innerHeight, devicePixelRatio][index]),
  };
  return result;
};
