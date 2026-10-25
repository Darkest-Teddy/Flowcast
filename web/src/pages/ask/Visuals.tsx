import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { ChartLine, Table2 } from 'lucide-react';
import { crowdScale, series as seriesColors } from '@theme/tokens';
import type { BarVisual as Bar, LineVisual as Line, Provenance, StatsVisual as Stats, Visual } from '@map/chatContract';
import { Table, Tag } from '../../ui';
import { PROVENANCE_LABEL } from '../../lib/chatParse';
import { formatValue, tickText, visualToTable, xLabelIndexes, yScale, type TableView } from '../../lib/chatVisuals';
import styles from './Visuals.module.css';

const PROVENANCE_TONE: Record<Provenance, 'accent' | 'ok' | 'warn' | 'off'> = {
  simulated: 'accent',
  published: 'ok',
  assumption: 'warn',
  mixed: 'off',
};

/** "Simulated", "Published", "Assumption" or "Mixed": where a figure comes from. Always a word, never colour alone. */
export function ProvenanceBadge({ kind }: { kind: Provenance }) {
  return <Tag tone={PROVENANCE_TONE[kind]}>{PROVENANCE_LABEL[kind]}</Tag>;
}

/** One visual from a chat answer: title, provenance and note around the chart, with a table view for charts. */
export function VisualCard({ visual }: { visual: Visual }) {
  const chart = visual.kind === 'line' || visual.kind === 'bar';
  const [asTable, setAsTable] = useState(false);
  const titleId = useId();
  return (
    <figure className={styles.card} aria-labelledby={titleId}>
      <figcaption className={styles.head}>
        <div className={styles.titleRow}>
          <h4 id={titleId} className={styles.title}>{visual.title}</h4>
          <ProvenanceBadge kind={visual.source} />
        </div>
        {chart && (
          <button type="button" className={styles.toggle} aria-pressed={asTable} onClick={() => setAsTable((v) => !v)}>
            {asTable ? <ChartLine aria-hidden /> : <Table2 aria-hidden />}
            {asTable ? 'Show as chart' : 'Show as table'}
          </button>
        )}
      </figcaption>
      <div className={styles.body}>
        {(asTable || visual.kind === 'table') && <DataTable view={visualToTable(visual)} caption={visual.title} />}
        {!asTable && visual.kind === 'line' && <LineChart visual={visual} />}
        {!asTable && visual.kind === 'bar' && <BarChart visual={visual} />}
        {visual.kind === 'stats' && <StatTiles visual={visual} />}
      </div>
      {visual.note && <p className={styles.note}>{visual.note}</p>}
    </figure>
  );
}

function DataTable({ view, caption }: { view: TableView; caption: string }) {
  const rows = view.rows.map((r, i) => ({ ...r, __key: String(i) }));
  return (
    <div className={styles.tableWrap} tabIndex={0} role="region" aria-label={`${caption}, table`}>
      <Table
        caption={caption}
        rowKey={(r) => r.__key}
        rows={rows}
        columns={view.columns.map((c) => ({
          key: c.key,
          header: c.label,
          align: c.align,
          render: (r: Record<string, string>) => <span className={c.align === 'right' ? styles.num : undefined}>{r[c.key]}</span>,
        }))}
      />
    </div>
  );
}

/** Width of an element, kept current as it resizes. */
function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const observer = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width)));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

const CHART_HEIGHT = 200;
const PAD = { top: 20, bottom: 24, left: 40 };
const LABEL_GAP = 14;

/** Runs of consecutive non-null values, so a null draws as a gap rather than a drop to zero. */
function segments(values: (number | null)[]): { start: number; points: number[] }[] {
  const out: { start: number; points: number[] }[] = [];
  values.forEach((v, i) => {
    if (v === null) return;
    const last = out[out.length - 1];
    if (last && last.start + last.points.length === i) last.points.push(v);
    else out.push({ start: i, points: [v] });
  });
  return out;
}

/** Values over the day: thin lines, a crosshair and readout on hover or arrow keys, nulls as gaps. */
function LineChart({ visual }: { visual: Line }) {
  const [wrap, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  const multi = visual.series.length > 1;
  const scale = yScale(visual.series.flatMap((s) => s.values), visual.unit);
  const n = visual.x.length;

  // Direct end labels for 2–4 series, when there's room on the right.
  const lastPoint = visual.series.map((s) => {
    for (let i = s.values.length - 1; i >= 0; i--) if (s.values[i] !== null) return { i, v: s.values[i] as number };
    return null;
  });
  const labelChars = Math.max(...visual.series.map((s) => s.name.length));
  const wantLabels = multi && width >= 420;
  const right = wantLabels ? Math.min(120, 16 + labelChars * 7) : 12;
  const plotW = Math.max(1, width - PAD.left - right);
  const plotH = CHART_HEIGHT - PAD.top - PAD.bottom;
  const xAt = (i: number) => PAD.left + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const yAt = (v: number) => PAD.top + plotH - ((v - scale.min) / (scale.max - scale.min)) * plotH;

  const ends = lastPoint.map((p, si) => (p ? { si, y: yAt(p.v), x: xAt(p.i) } : null)).filter((e): e is { si: number; y: number; x: number } => e !== null);
  const sortedY = ends.map((e) => e.y).sort((a, b) => a - b);
  const labelsFit = wantLabels && sortedY.every((y, i) => i === 0 || y - sortedY[i - 1] >= LABEL_GAP);

  const pick = (e: PointerEvent<SVGRectElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const fraction = (e.clientX - box.left) / Math.max(1, box.width);
    setActive(Math.max(0, Math.min(n - 1, Math.round(fraction * (n - 1)))));
  };
  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    const moves: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1 };
    if (e.key in moves) {
      e.preventDefault();
      setActive((a) => Math.max(0, Math.min(n - 1, (a ?? (e.key === 'ArrowRight' ? -1 : n)) + moves[e.key])));
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      setActive(e.key === 'Home' ? 0 : n - 1);
    } else if (e.key === 'Escape') setActive(null);
  };

  const readout = active === null ? '' : `${visual.x[active]}: ${visual.series.map((s) => `${s.name} ${s.values[active] === null ? 'no value' : formatValue(s.values[active], visual.unit)}`).join(', ')}`;
  const xTicks = xLabelIndexes(n, Math.max(2, Math.floor(plotW / 64)));
  const tipLeft = active === null ? 0 : xAt(active);
  const tipFlip = tipLeft > width - 180;

  return (
    <div className={styles.chartWrap}>
      {multi && (
        <ul className={styles.legend} aria-label="Series">
          {visual.series.map((s, i) => (
            <li key={s.name}>
              <i className={styles.lineKey} style={{ background: seriesColors[i] }} aria-hidden />
              {s.name}
            </li>
          ))}
        </ul>
      )}
      {visual.unit && <p className={styles.unit} aria-hidden>{visual.unit}</p>}
      <div ref={wrap} className={styles.plot}>
        {width > 0 && (
          <svg
            width={width}
            height={CHART_HEIGHT}
            className={styles.svg}
            role="img"
            tabIndex={0}
            aria-label={`${visual.title}. Line chart of ${visual.unit || 'values'} over ${n} points, ${visual.series.map((s) => s.name).join(', ')}. Use the left and right arrow keys to read each point, or Show as table.`}
            onKeyDown={onKey}
            onBlur={() => setActive(null)}
          >
            {scale.ticks.map((t) => (
              <g key={t}>
                <line x1={PAD.left} x2={PAD.left + plotW} y1={yAt(t)} y2={yAt(t)} className={t === 0 ? styles.baseline : styles.grid} />
                <text x={PAD.left - 6} y={yAt(t)} className={styles.yTick} dominantBaseline="middle" textAnchor="end">
                  {tickText(t)}
                </text>
              </g>
            ))}
            {xTicks.map((i) => (
              <text key={i} x={xAt(i)} y={CHART_HEIGHT - 6} className={styles.xTick} textAnchor={i === 0 && n > 1 ? 'start' : i === n - 1 && n > 1 ? 'end' : 'middle'}>
                {visual.x[i]}
              </text>
            ))}
            {visual.marker && (
              <g>
                <line x1={xAt(visual.marker.index)} x2={xAt(visual.marker.index)} y1={PAD.top} y2={PAD.top + plotH} className={styles.marker} />
                <text x={xAt(visual.marker.index)} y={PAD.top - 6} className={styles.markerLabel} textAnchor="middle">{visual.marker.label}</text>
              </g>
            )}
            {visual.series.map((s, si) =>
              segments(s.values).map((seg) =>
                seg.points.length === 1 ? (
                  <circle key={`${si}-${seg.start}`} cx={xAt(seg.start)} cy={yAt(seg.points[0])} r={3} style={{ fill: seriesColors[si] }} />
                ) : (
                  <polyline
                    key={`${si}-${seg.start}`}
                    points={seg.points.map((v, k) => `${xAt(seg.start + k)},${yAt(v)}`).join(' ')}
                    className={styles.line}
                    style={{ stroke: seriesColors[si] }}
                  />
                ),
              ),
            )}
            {labelsFit &&
              ends.map((e) => (
                <text key={e.si} x={e.x + 8} y={e.y} className={styles.endLabel} dominantBaseline="middle">
                  {visual.series[e.si].name}
                </text>
              ))}
            {active !== null && (
              <g aria-hidden>
                <line x1={xAt(active)} x2={xAt(active)} y1={PAD.top} y2={PAD.top + plotH} className={styles.crosshair} />
                {visual.series.map((s, si) => {
                  const v = s.values[active];
                  return v === null ? null : <circle key={si} cx={xAt(active)} cy={yAt(v)} r={4} className={styles.dot} style={{ fill: seriesColors[si] }} />;
                })}
              </g>
            )}
            <rect
              x={PAD.left}
              y={0}
              width={plotW}
              height={CHART_HEIGHT}
              className={styles.hit}
              onPointerMove={pick}
              onPointerDown={pick}
              onPointerLeave={(e) => e.pointerType === 'mouse' && setActive(null)}
            />
          </svg>
        )}
        {active !== null && (
          <div className={styles.tooltip} style={{ left: tipLeft, transform: tipFlip ? 'translateX(calc(-100% - 12px))' : 'translateX(12px)' }} aria-hidden>
            <div className={styles.tipHead}>{visual.x[active]}</div>
            {visual.series.map((s, si) => (
              <div key={s.name} className={styles.tipRow}>
                <i className={styles.lineKey} style={{ background: seriesColors[si] }} />
                <strong>{formatValue(s.values[active], visual.unit)}</strong>
                {multi && <span>{s.name}</span>}
              </div>
            ))}
          </div>
        )}
        <span className="visually-hidden" aria-live="polite">{readout}</span>
      </div>
    </div>
  );
}

const crowdByWord = new Map(crowdScale.map((c) => [c.label.toLowerCase(), c]));

/** A ranking: one horizontal bar per thing, with its value and crowd word in text beside it. */
function BarChart({ visual }: { visual: Bar }) {
  const [active, setActive] = useState<number | null>(null);
  const values = visual.bars.map((b) => b.value ?? 0);
  const max = Math.max(visual.unit.trim().startsWith('%') ? 100 : 0, ...values, 1);

  return (
    <ul className={styles.bars} aria-label={visual.title}>
      {visual.bars.map((b, i) => {
        const level = b.level ? crowdByWord.get(b.level.toLowerCase()) : undefined;
        const value = formatValue(b.value, visual.unit);
        const text = [value === '—' ? 'No value' : value, b.level].filter(Boolean).join(', ');
        return (
          <li
            key={`${b.label}-${i}`}
            className={`${styles.barRow} ${active === i ? styles.barOn : ''}`}
            tabIndex={0}
            onPointerEnter={() => setActive(i)}
            onPointerLeave={() => setActive((a) => (a === i ? null : a))}
            onFocus={() => setActive(i)}
            onBlur={() => setActive((a) => (a === i ? null : a))}
          >
            <span className={styles.barLabel}>
              {b.label}
              {b.detail && <span className={styles.barDetail}>{b.detail}</span>}
            </span>
            <span className={styles.track} aria-hidden>
              {b.value !== null && b.value > 0 && (
                <span
                  className={styles.fill}
                  style={{ width: `${Math.max(1, Math.min(100, (b.value / max) * 100))}%`, background: level?.color ?? seriesColors[0] }}
                />
              )}
            </span>
            <span className={styles.barValue}>{text}</span>
            {active === i && (
              <span className={styles.barTip} role="tooltip">
                <strong>{text}</strong>
                <span className={styles.tipSub}>{b.label}{b.detail ? ` · ${b.detail}` : ''}</span>
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** A few headline figures as tiles. */
function StatTiles({ visual }: { visual: Stats }) {
  return (
    <dl className={styles.stats}>
      {visual.items.map((item, i) => (
        <div key={`${item.label}-${i}`} className={styles.stat}>
          <dt>{item.label}</dt>
          <dd className={styles.statValue}>{item.value}</dd>
          {item.detail && <dd className={styles.statDetail}>{item.detail}</dd>}
        </div>
      ))}
    </dl>
  );
}
