// Simplified, token-styled sketches of each main screen for the Get started tour. Decorative only:
// the step text carries the meaning, so every preview is hidden from assistive tech.

import type { CSSProperties, ReactNode } from 'react';
import { crowdScale, swatches } from '@theme/tokens';
import styles from './TourPreviews.module.css';

const w = (percent: number): CSSProperties => ({ width: `${percent}%` });
/** An index into the crowd scale: 0 Quiet, 1 Busy, 2 Packed (theme/crowd.ts). */
const crowd = (level: number) => crowdScale[level].color;

function Frame({ children, sidebar = true }: { children: ReactNode; sidebar?: boolean }) {
  return (
    <div className={`${styles.frame} ${sidebar ? '' : styles.noSide}`} aria-hidden>
      {sidebar && (
        <div className={styles.side}>
          <i className={styles.brand} />
          {[70, 55, 62, 48, 58].map((n, i) => (
            <i key={i} className={styles.line} style={w(n)} />
          ))}
        </div>
      )}
      <div className={styles.main}>{children}</div>
    </div>
  );
}

function HomePreview() {
  const tiles = [
    [3, 5, 2, 6, 4],
    [1, 2, 4, 1, 2],
    [2, 1, 3, 1, 1],
    [2, 5, 7, 4, 3],
  ];
  return (
    <Frame>
      <i className={styles.search} />
      <div className={styles.tiles}>
        {tiles.map((series, t) => (
          <div key={t} className={styles.tile}>
            <i className={styles.lineSm} style={w(60)} />
            <i className={styles.value} />
            <div className={styles.bars}>
              {series.map((v, i) => (
                <i key={i} className={i === 2 ? styles.barOn : undefined} style={{ height: `${v * 14}%` }} />
              ))}
            </div>
          </div>
        ))}
      </div>
      {[64, 48, 56].map((n, i) => (
        <div key={i} className={styles.row}>
          <i className={styles.line} style={w(n)} />
          <i className={styles.lineSm} style={w(14)} />
        </div>
      ))}
    </Frame>
  );
}

function SchedulePreview() {
  const rows = [
    { title: 38, share: 30, level: 0 },
    { title: 30, share: 88, level: 2 },
    { title: 44, share: 55, level: 1 },
    { title: 34, share: 74, level: 1 },
  ];
  return (
    <Frame>
      <div className={styles.suggestion}>
        <i className={styles.lineAccent} style={w(70)} />
      </div>
      {rows.map((r, i) => (
        <div key={i} className={styles.row}>
          <i className={styles.lineSm} style={w(12)} />
          <i className={styles.line} style={w(r.title)} />
          <span className={styles.meter}>
            <b style={{ width: `${r.share}%`, background: crowd(r.level) }} />
          </span>
        </div>
      ))}
      <div className={styles.chart}>
        {[12, 22, 35, 62, 94, 81, 44, 33, 41, 58, 72, 40].map((v, i) => (
          <i key={i} style={{ height: `${v}%`, background: crowd(crowdScale.findIndex((s) => v / 100 < s.upTo)) }} />
        ))}
      </div>
    </Frame>
  );
}

function MapPreview() {
  const buildings = [
    { left: 8, top: 14, width: 18, height: 22 },
    { left: 32, top: 8, width: 14, height: 30 },
    { left: 54, top: 18, width: 22, height: 18 },
    { left: 14, top: 52, width: 24, height: 20 },
    { left: 48, top: 50, width: 16, height: 28 },
    { left: 72, top: 56, width: 18, height: 18 },
  ];
  const dots = [
    [24, 40, 0], [28, 44, 0], [40, 42, 1], [44, 40, 1], [46, 46, 1], [60, 40, 1], [64, 44, 1], [62, 38, 1],
    [66, 42, 2], [68, 46, 2], [70, 40, 2], [30, 80, 0], [56, 82, 1], [80, 50, 0], [12, 44, 0],
  ];
  return (
    <Frame sidebar={false}>
      <div className={styles.map}>
        <i className={styles.road} style={{ top: '42%' }} />
        <i className={styles.roadV} style={{ left: '44%' }} />
        {buildings.map((b, i) => (
          <i
            key={i}
            className={styles.building}
            style={{ left: `${b.left}%`, top: `${b.top}%`, width: `${b.width}%`, height: `${b.height}%` }}
          />
        ))}
        {dots.map(([left, top, level], i) => (
          <i key={i} className={styles.dot} style={{ left: `${left}%`, top: `${top}%`, background: crowd(level) }} />
        ))}
        <div className={styles.legend}>
          {crowdScale.map((s) => (
            <span key={s.level}>
              <i style={{ background: s.color }} />
              {s.label}
            </span>
          ))}
        </div>
      </div>
    </Frame>
  );
}

function ClubsPreview() {
  const clubs = [
    { name: 46, following: true },
    { name: 38, following: true },
    { name: 52, following: false },
  ];
  return (
    <Frame>
      {clubs.map((c, i) => (
        <div key={i} className={styles.row}>
          <i className={styles.swatch} style={{ background: swatches[i] }} />
          <i className={styles.line} style={w(c.name)} />
          <i className={styles.verified} />
          <i className={c.following ? styles.pillOn : styles.pill} />
        </div>
      ))}
      <i className={styles.heading} />
      {[50, 42].map((n, i) => (
        <div key={i} className={styles.row}>
          <i className={styles.dateBox} />
          <i className={styles.line} style={w(n)} />
          <i className={styles.lineSm} style={w(16)} />
        </div>
      ))}
    </Frame>
  );
}

function PrivacyPreview() {
  return (
    <Frame>
      <i className={styles.heading} />
      {[
        [58, true],
        [44, true],
        [50, false],
      ].map(([n, on], i) => (
        <div key={i} className={styles.row}>
          <i className={styles.line} style={w(n as number)} />
          <i className={on ? styles.switchOn : styles.switchOff} />
        </div>
      ))}
      <div className={styles.note}>
        <i className={styles.lineSm} style={w(80)} />
        <i className={styles.lineSm} style={w(50)} />
      </div>
      <div className={styles.buttons}>
        <i className={styles.button} />
        <i className={styles.buttonDanger} />
      </div>
    </Frame>
  );
}

export const tourPreviews = {
  home: HomePreview,
  schedule: SchedulePreview,
  map: MapPreview,
  clubs: ClubsPreview,
  privacy: PrivacyPreview,
} as const;

export type TourPreviewId = keyof typeof tourPreviews;
