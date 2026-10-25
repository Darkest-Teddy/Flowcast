import type { CSSProperties } from 'react';
import { crowdFor } from '@theme/tokens';
import styles from './CampusScene.module.css';

/**
 * A stylised CSS 3D model of BU's three campuses for the landing page: a tilted ground plane with
 * the river, Comm Ave and boxes for buildings. It is decoration (hidden from assistive tech), not
 * the real map: the layout is schematic, but each named box takes its colour from the real
 * simulated crowding of the place it stands for. Boxes without a place, or before the forecast
 * has loaded, are neutral context buildings.
 */

interface SceneBuilding {
  /** Matches a place id in the event-impact data, or null for a context building. */
  place: string | null;
  x: number;
  y: number;
  w: number;
  d: number;
  h: number;
}

const BUILDINGS: SceneBuilding[] = [
  { place: 'claflin', x: 70, y: 190, w: 70, d: 50, h: 70 },
  { place: 'sleeper', x: 160, y: 190, w: 70, d: 50, h: 70 },
  { place: null, x: 250, y: 200, w: 60, d: 45, h: 60 },
  { place: 'agganis', x: 110, y: 380, w: 150, d: 100, h: 40 },
  { place: 'stuvi', x: 300, y: 380, w: 50, d: 50, h: 170 },
  { place: 'stuvi2', x: 370, y: 400, w: 50, d: 50, h: 150 },
  { place: null, x: 430, y: 220, w: 60, d: 40, h: 30 },
  { place: 'fitrec', x: 450, y: 380, w: 130, d: 80, h: 45 },
  { place: null, x: 520, y: 205, w: 50, d: 50, h: 35 },
  { place: null, x: 560, y: 490, w: 60, d: 40, h: 28 },
  { place: 'photonics', x: 600, y: 200, w: 70, d: 60, h: 80 },
  { place: 'questrom', x: 650, y: 370, w: 90, d: 60, h: 55 },
  { place: 'cds', x: 700, y: 195, w: 60, d: 60, h: 200 },
  { place: 'warren', x: 770, y: 370, w: 120, d: 50, h: 110 },
  { place: 'cas', x: 790, y: 205, w: 110, d: 70, h: 50 },
  { place: null, x: 880, y: 470, w: 50, d: 40, h: 30 },
  { place: null, x: 920, y: 220, w: 30, d: 40, h: 40 },
  { place: 'mugar', x: 965, y: 205, w: 70, d: 70, h: 65 },
  { place: 'gsu', x: 960, y: 370, w: 90, d: 60, h: 40 },
  { place: 'marciano', x: 1060, y: 180, w: 60, d: 50, h: 45 },
  { place: 'kilachand', x: 1080, y: 250, w: 40, d: 40, h: 90 },
  { place: null, x: 1110, y: 380, w: 60, d: 50, h: 35 },
  { place: 'riverway-house', x: 1000, y: 600, w: 70, d: 50, h: 50 },
  { place: 'fenway-dining', x: 1090, y: 610, w: 60, d: 60, h: 40 },
  { place: 'fenway-classroom', x: 1010, y: 670, w: 60, d: 40, h: 35 },
  { place: 'bumc-instructional', x: 1240, y: 770, w: 80, d: 50, h: 90 },
  { place: 'bumc-library', x: 1330, y: 780, w: 50, d: 60, h: 60 },
  { place: null, x: 1250, y: 840, w: 60, d: 40, h: 40 },
];

const px = (n: number) => `${n}px`;

export function CampusScene({
  shareOf,
  scale = 1,
  dx = 0,
  dy = 0,
  className,
}: {
  /** Share of capacity (0–1+) for a place id at the scene's hour; null while unknown. */
  shareOf: (place: string) => number | null;
  scale?: number;
  dx?: number;
  dy?: number;
  className?: string;
}) {
  return (
    <div className={`${styles.scene} ${className ?? ''}`} aria-hidden>
      <div className={styles.world} style={{ transform: `translate(${px(dx)}, ${px(dy)}) scale(${scale})` }}>
        <div className={styles.ground}>
          <div className={styles.river} />
          <span className={styles.riverLabel}>Charles River</span>
          <div className={styles.commAve} />
          <div className={styles.cross} />
          <div className={styles.path} />
          <span className={styles.areaLabel} style={{ left: px(80), top: px(588) }}>Charles River Campus</span>
          <span className={styles.areaLabel} style={{ left: px(960), top: px(740) }}>Fenway</span>
          <span className={styles.areaLabel} style={{ left: px(1250), top: px(720) }}>Medical</span>
          {BUILDINGS.map((b) => {
            const share = b.place ? shareOf(b.place) : null;
            const style = {
              left: px(b.x),
              top: px(b.y),
              '--w': px(b.w),
              '--d': px(b.d),
              '--h': px(b.h),
              ...(share != null ? { '--c': crowdFor(share).color } : null),
            } as CSSProperties;
            return (
              <div key={`${b.x}-${b.y}`} className={`${styles.building} ${share == null ? styles.context : ''}`} style={style} data-place={b.place ?? undefined}>
                <span className={styles.glow} />
                <span className={styles.north} />
                <span className={styles.west} />
                <span className={styles.east} />
                <span className={styles.south} />
                <span className={styles.roof}>
                  {b.place && <span className={styles.anchor} data-anchor={b.place} />}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
