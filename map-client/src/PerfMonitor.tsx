// Build-time performance readout: FPS, frame times, memory and what's being drawn.
// On by default for now; `P` toggles it, ?perf=0 hides it.
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { quality, type QualityMode } from './perf/quality';
import { mapGpuInfo, type GpuInfo } from './gpu';

export interface PerfCounts {
  walkers: number;
  vehicles: number;
  layers: number;
}

interface Sample {
  fps: number;
  low1: number; // 1% low FPS: the average FPS of the slowest 1% of frames (rolling 10 s)
  avgMs: number;
  worstMs: number; // slowest frame in the last second
  heapMb: number | null;
}

const WINDOW_MS = 1000;
const LOW_WINDOW_FRAMES = 600; // ~10 s at 60 fps, so a 1% low covers ~6 frames

/** 1% low FPS: mean frame time of the slowest 1% of frames, as FPS. */
function onePercentLow(frameTimes: number[]): number {
  const sorted = [...frameTimes].sort((a, b) => b - a);
  const worst = sorted.slice(0, Math.max(1, Math.ceil(sorted.length * 0.01)));
  return 1000 / (worst.reduce((a, b) => a + b, 0) / worst.length);
}

export function PerfMonitor({ counts }: { counts: () => PerfCounts | null }) {
  const [visible, setVisible] = useState(() => new URLSearchParams(window.location.search).get('perf') !== '0');
  const [sample, setSample] = useState<Sample | null>(null);
  const [tally, setTally] = useState<PerfCounts | null>(null);
  const [gpu, setGpu] = useState<GpuInfo | null>(null);
  const history = useRef<number[]>([]); // fps per second, for the sparkline

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (e.metaKey || e.ctrlKey || e.altKey || target?.closest('input, select, textarea')) return;
      if (e.key === 'p' || e.key === 'P') setVisible((v) => !v);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (!visible) return;
    let frame = 0;
    let last = performance.now();
    let windowStart = last;
    let frames: number[] = [];
    let recent: number[] = []; // frame times for the rolling 1% low
    const loop = (now: number) => {
      frames.push(now - last);
      recent.push(now - last);
      if (recent.length > LOW_WINDOW_FRAMES) recent = recent.slice(-LOW_WINDOW_FRAMES);
      last = now;
      if (now - windowStart >= WINDOW_MS) {
        const total = frames.reduce((a, b) => a + b, 0);
        const fps = (frames.length * 1000) / total;
        const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
        setSample({
          fps,
          low1: onePercentLow(recent),
          avgMs: total / frames.length,
          worstMs: Math.max(...frames),
          heapMb: memory ? memory.usedJSHeapSize / 1048576 : null,
        });
        setTally(counts());
        setGpu((g) => g ?? mapGpuInfo());
        history.current = [...history.current.slice(-39), fps];
        frames = [];
        windowStart = now;
      }
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [visible, counts]);

  const perfSettings = useSyncExternalStore(quality.subscribe, () => quality.settings);
  const mode = useSyncExternalStore(quality.subscribe, () => quality.mode);

  if (!visible || !sample) return null;
  const level = sample.fps >= 50 ? 'good' : sample.fps >= 30 ? 'ok' : 'bad';
  const points = history.current.map((f, i) => `${i * 3},${24 - Math.min(60, f) * 0.4}`).join(' ');

  return (
    <div className="panel perf" role="status" aria-label="Performance monitor">
      <div className="perf-head">
        <div className={`perf-fps ${level}`}>
          {Math.round(sample.fps)} <span>FPS</span>
        </div>
        <div className={`perf-low ${sample.low1 >= 45 ? 'good' : sample.low1 >= 25 ? 'ok' : 'bad'}`}>
          {Math.round(sample.low1)} <span>1% low</span>
        </div>
      </div>
      <svg className="perf-graph" viewBox="0 0 120 24" aria-hidden="true">
        <line x1="0" x2="120" y1={24 - 60 * 0.4} y2={24 - 60 * 0.4} />
        <line x1="0" x2="120" y1={24 - 30 * 0.4} y2={24 - 30 * 0.4} />
        <polyline points={points} />
      </svg>
      <dl>
        {gpu && (
          <>
            <dt>gpu</dt>
            <dd className={gpu.software ? 'perf-warn' : undefined}>
              {gpu.software ? `${gpu.renderer} (software: turn on hardware acceleration)` : gpu.renderer}
            </dd>
          </>
        )}
        <dt>frame</dt>
        <dd>
          {sample.avgMs.toFixed(1)} ms · worst {sample.worstMs.toFixed(0)}
        </dd>
        {sample.heapMb !== null && (
          <>
            <dt>memory</dt>
            <dd>{sample.heapMb.toFixed(0)} MB</dd>
          </>
        )}
        {tally && (
          <>
            <dt>drawing</dt>
            <dd>
              {tally.walkers} walkers · {tally.vehicles} vehicles · {tally.layers} layers
            </dd>
          </>
        )}
      </dl>
      <div className="perf-quality" role="group" aria-label="Performance">
        <span>Performance</span>
        {(['auto', 'quality', 'speed'] as QualityMode[]).map((m) => (
          <button key={m} onClick={() => quality.setMode(m)} aria-pressed={mode === m}>
            {m === 'auto' ? 'Auto' : m === 'quality' ? 'Quality' : 'Speed'}
          </button>
        ))}
      </div>
      <p className="perf-hint">
        {ratio(quality.pixelRatio)}x pixels
        {mode !== 'auto' && perfSettings.pixelRatio !== quality.pixelRatio && ` (${ratio(perfSettings.pixelRatio)}x after reload)`}
        {mode === 'auto' && ` · level ${perfSettings.level}`}
        {mode === 'speed' && ' · no MSAA after reload'} · P to hide
      </p>
    </div>
  );
}

const ratio = (r: number) => r.toFixed(2).replace(/\.?0+$/, '');
