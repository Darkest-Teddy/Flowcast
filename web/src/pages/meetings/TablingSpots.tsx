import { useMemo, useState } from 'react';
import { api, useResource } from '../../data/api';
import { answerMapLink } from '../../lib/askMapLink';
import { config } from '../../config';
import { errorText, hourLabel, rankTablingSpots } from '../../lib/orgs';
import { Button, EmptyState, Loading, SelectField } from '../../ui';
import styles from '../Meetings.module.css';

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const WINDOWS = [{ value: '10-14', label: 'Late morning to lunch (10 AM–2 PM)' }, { value: '11-13', label: 'Lunch (11 AM–1 PM)' }, { value: '14-18', label: 'Afternoon (2–6 PM)' }, { value: '16-20', label: 'After classes (4–8 PM)' }, { value: '8-22', label: 'All day (8 AM–10 PM)' }];

/** Where to table or flyer: outdoor spots and building fronts ranked by simulated people walking by. */
export function TablingSpots() {
  const impact = useResource(api.getEventImpact);
  const [weekday, setWeekday] = useState(() => Math.min(4, (new Date().getDay() + 6) % 7));
  const [span, setSpan] = useState('10-14');
  const [from, to] = span.split('-').map(Number);
  const foot = impact.data?.footTraffic;
  // Spots no simulated walking route passes (riverside lawns, the river path) would only ever read 0: left out and named.
  const unrouted = useMemo(() => new Set((foot?.spots ?? []).filter((s) => Object.values(foot!.baseline).every((day) => !(day[s.id] ?? []).some(Boolean))).map((s) => s.id)), [foot]);
  const ranked = useMemo(() => (foot ? rankTablingSpots(foot, weekday, from, to).filter((s) => !unrouted.has(s.id)) : []), [foot, weekday, from, to, unrouted]);
  if (impact.loading) return <Loading label="Loading foot traffic" />;
  if (impact.error) return <p role="alert">{errorText(impact.error)}</p>;
  if (!foot) return <EmptyState title="Foot traffic isn’t available yet" body="This server’s campus data predates foot-traffic counts. It appears after the next data import." />;
  const top = ranked[0]?.total || 1;
  return <>
    <section className={styles.filters} aria-label="Tabling spots">
      <div className={styles.controls}>
        <SelectField label="Day" value={weekday} onChange={(e) => setWeekday(Number(e.target.value))}>
          {DAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
        </SelectField>
        <SelectField label="Time" value={span} onChange={(e) => setSpan(e.target.value)}>
          {WINDOWS.map((w) => <option key={w.value} value={w.value}>{w.label}</option>)}
        </SelectField>
      </div>
      <p className={styles.muted}>Simulated people walking into each spot, a typical week. Each pass counts once. Building fronts count everyone within 30 m, including people going in and out. Not measured counts, and tabling rules and bookings for each spot are BU’s: check before you set up.</p>
    </section>
    <ul className={styles.list} aria-label="Spots by foot traffic">
      {ranked.map((s, i) => {
        const spot = foot.spots.find((x) => x.id === s.id)!;
        const map = answerMapLink(config.mapUrl, [spot.position]);
        return <li key={s.id} className={styles.card}>
          <p className={styles.when}>#{i + 1} · busiest at {hourLabel(s.peakHour)}</p>
          <h3>{s.name}</h3>
          <p className={styles.where}><strong>{s.total.toLocaleString()}</strong> people walking by, {hourLabel(from)}–{hourLabel(to)}</p>
          <div className={styles.bars} aria-hidden>
            {s.hourly.slice(from, to).map((n, k) => <span key={k} style={{ height: `${Math.max(4, Math.round((n / Math.max(1, ...ranked.map((r) => Math.max(...r.hourly.slice(from, to))))) * 100))}%` }} title={`${hourLabel(from + k)}: ${n}`} />)}
          </div>
          <div className={styles.meter} aria-hidden><span style={{ width: `${Math.round((s.total / top) * 100)}%` }} /></div>
          {map && <div className={styles.actions}><Button href={map} size="sm" variant="ghost">View on map</Button></div>}
        </li>;
      })}
    </ul>
    {unrouted.size > 0 && <p className={styles.muted}>Not ranked: {foot.spots.filter((s) => unrouted.has(s.id)).map((s) => s.name).join(', ')}. No simulated walking route passes them, so the model can’t say how busy they are.</p>}
  </>;
}
