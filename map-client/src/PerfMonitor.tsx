// Build-time performance readout: FPS, frame times, memory and what's being drawn.
// On by default for now; `P` toggles it, ?perf=0 hides it.
import { useEffect, useRef, useState } from 'react';

export interface PerfCounts {
  walkers: number;
  vehicles: number;
  layers: number;
}

interface Sample {
  fps: number;
  avgMs: number;
  worstMs: number; // slowest frame in the last second
  heapMb: number | null;
}

const WINDOW_MS = 1000;

export function PerfMonitor({ counts }: { counts: () => PerfCounts | null }) {
  const [visible, setVisible] = useState(() => new URLSearchParams(window.location.search).get('perf') !== '0');
  const [sample, setSample] = useState<Sample | null>(null);
  const [tally, setTally] = useState<PerfCounts | null>(null);
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
    const loop = (now: number) => {
      frames.push(now - last);
      last = now;
      if (now - windowStart >= WINDOW_MS) {
        const total = frames.reduce((a, b) => a + b, 0);
        const fps = (frames.length * 1000) / total;
        const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
        setSample({
          fps,
          avgMs: total / frames.length,
          worstMs: Math.max(...frames),
          heapMb: memory ? memory.usedJSHeapSize / 1048576 : null,
        });
        setTally(counts());
        history.current = [...history.current.slice(-39), fps];
        frames = [];
        windowStart = now;
      }
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [visible, counts]);

  if (!visible || !sample) return null;
  const level = sample.fps >= 50 ? 'good' : sample.fps >= 30 ? 'ok' : 'bad';
  const points = history.current.map((f, i) => `${i * 3},${24 - Math.min(60, f) * 0.4}`).join(' ');

  return (
    <div className="panel perf" role="status" aria-label="Performance monitor">
      <div className={`perf-fps ${level}`}>
        {Math.round(sample.fps)} <span>FPS</span>
      </div>
      <svg className="perf-graph" viewBox="0 0 120 24" aria-hidden="true">
        <line x1="0" x2="120" y1={24 - 60 * 0.4} y2={24 - 60 * 0.4} />
        <line x1="0" x2="120" y1={24 - 30 * 0.4} y2={24 - 30 * 0.4} />
        <polyline points={points} />
      </svg>
      <dl>
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
      <p className="perf-hint">P to hide</p>
    </div>
  );
}
