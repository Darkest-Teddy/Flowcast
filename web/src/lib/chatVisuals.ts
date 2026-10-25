// Pure helpers behind the chat's visuals: every chart's table equivalent (so no figure is ever
// chart-only), value formatting with units, and the y-axis scale for line charts. No imports, so
// node --test runs it as is.

import type { Visual } from '@map/chatContract';

export interface TableView {
  columns: { key: string; label: string; align: 'left' | 'right' }[];
  /** Display text per column key; missing values are "—". */
  rows: Record<string, string>[];
}

export const MISSING = '—';

/** 71 → "71", 1547 → "1,547", 3.14159 → "3.1". */
export function formatNumber(n: number): string {
  const rounded = Math.abs(n) >= 100 ? Math.round(n) : Math.round(n * 10) / 10;
  return rounded.toLocaleString('en-US');
}

/** A value with its unit: "71% full", "1,547 students", "12 rides/h". */
export function formatValue(n: number | null, unit: string): string {
  if (n === null) return MISSING;
  const u = unit.trim();
  if (!u) return formatNumber(n);
  return u.startsWith('%') ? `${formatNumber(n)}${u}` : `${formatNumber(n)} ${u}`;
}

const cell = (v: string | number | null | undefined) => (v === null || v === undefined || v === '' ? MISSING : typeof v === 'number' ? formatNumber(v) : v);
const looksLikeTimes = (labels: string[]) => labels.length > 0 && labels.every((l) => /^\d{1,2}(:\d{2})?\s?(AM|PM|am|pm)?$/.test(l.trim()) || /noon|midnight/i.test(l));

/** The same data as a table, for "Show as table" and for screen readers. */
export function visualToTable(visual: Visual): TableView {
  switch (visual.kind) {
    case 'line': {
      const unit = visual.unit ? ` (${visual.unit})` : '';
      const columns: TableView['columns'] = [
        { key: 'x', label: looksLikeTimes(visual.x) ? 'Time' : 'Point', align: 'left' },
        ...visual.series.map((s, i) => ({ key: `s${i}`, label: `${s.name}${unit}`, align: 'right' as const })),
      ];
      const rows = visual.x.map((x, xi) => {
        const row: Record<string, string> = { x: visual.marker?.index === xi ? `${x} (${visual.marker.label})` : x };
        visual.series.forEach((s, si) => { row[`s${si}`] = cell(s.values[xi]); });
        return row;
      });
      return { columns, rows };
    }
    case 'bar': {
      const hasLevel = visual.bars.some((b) => b.level);
      const hasDetail = visual.bars.some((b) => b.detail);
      const columns: TableView['columns'] = [
        { key: 'label', label: 'Name', align: 'left' },
        { key: 'value', label: visual.unit ? `Value (${visual.unit})` : 'Value', align: 'right' },
        ...(hasLevel ? [{ key: 'level', label: 'Crowd level', align: 'left' as const }] : []),
        ...(hasDetail ? [{ key: 'detail', label: 'Detail', align: 'left' as const }] : []),
      ];
      const rows = visual.bars.map((b) => ({
        label: b.label,
        value: cell(b.value),
        ...(hasLevel ? { level: cell(b.level) } : {}),
        ...(hasDetail ? { detail: cell(b.detail) } : {}),
      }));
      return { columns, rows };
    }
    case 'table':
      return {
        columns: visual.columns.map((c) => ({ key: c.key, label: c.label, align: c.align })),
        rows: visual.rows.map((r) => Object.fromEntries(visual.columns.map((c) => [c.key, cell(r[c.key])]))),
      };
    case 'stats': {
      const hasDetail = visual.items.some((i) => i.detail);
      return {
        columns: [
          { key: 'label', label: 'Figure', align: 'left' },
          { key: 'value', label: 'Value', align: 'right' },
          ...(hasDetail ? [{ key: 'detail', label: 'Detail', align: 'left' as const }] : []),
        ],
        rows: visual.items.map((i) => ({ label: i.label, value: i.value, ...(hasDetail ? { detail: cell(i.detail) } : {}) })),
      };
    }
  }
}

/** 1, 2, 2.5 or 5 times a power of ten, at least `raw`. */
function niceStep(raw: number): number {
  if (!(raw > 0)) return 1;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const f = raw / pow;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * pow;
}

/**
 * Y axis for a line chart: from zero (or below, for negatives) to a clean maximum, with about
 * `count` round ticks. Percent units always show at least 0–100 so "full" reads at a glance.
 */
export function yScale(values: (number | null)[], unit: string, count = 4): { min: number; max: number; ticks: number[] } {
  const nums = values.filter((v): v is number => v !== null && Number.isFinite(v));
  let lo = Math.min(0, ...nums);
  let hi = Math.max(0, ...nums);
  if (unit.trim().startsWith('%')) hi = Math.max(100, hi);
  if (hi === lo) hi = lo + 1;
  const step = niceStep((hi - lo) / count);
  lo = Math.floor(lo / step) * step;
  hi = Math.ceil(hi / step) * step;
  const ticks: number[] = [];
  for (let t = lo; t <= hi + step / 1e6; t += step) ticks.push(Math.round(t * 1e6) / 1e6);
  return { min: lo, max: hi, ticks };
}

/** Compact tick text: 1,500 → "1.5K". */
export function tickText(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e6) return `${formatNumber(n / 1e6)}M`;
  if (a >= 1e3) return `${formatNumber(n / 1e3)}K`;
  return formatNumber(n);
}

/** Which x labels to print under a line chart so they don't collide: about `max` evenly spaced, always the ends. */
export function xLabelIndexes(length: number, max: number): number[] {
  if (length <= max) return Array.from({ length }, (_, i) => i);
  const step = Math.ceil((length - 1) / (max - 1));
  const out: number[] = [];
  for (let i = 0; i < length - 1; i += step) out.push(i);
  if (length - 1 - out[out.length - 1] < step / 2) out.pop();
  out.push(length - 1);
  return out;
}
