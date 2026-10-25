import { useState, type CSSProperties } from 'react';
import type { LightPreset } from './map/basemap';

// The intro's sky: haze and drifting clouds over the view of campus from above (styles and markup in
// public/intro/sky.css, which the pages load: web/index.html, web/map.html). The landing page's hero
// and the map's loading screen both show it; web/map.html builds the same markup before any code
// loads, with the same clock-based drift (keep its copy of introSkyDelays in step).

export type SkyPhase = 'sky' | 'drop' | 'land';

// One full drift there and back, in seconds: twice each layer's animation-duration in sky.css.
const PERIOD_A = 28;
const PERIOD_B = 34;

/** Drift delays from the clock, so every copy of the sky has its clouds in the same place at the same moment. */
export function introSkyDelays(now = Date.now()) {
  return { '--sky-a': `${-((now / 1000) % PERIOD_A)}s`, '--sky-b': `${-((now / 1000) % PERIOD_B)}s` };
}

export function IntroSky({ phase = 'sky', light, className }: { phase?: SkyPhase; light: LightPreset; className?: string }) {
  const [delays] = useState(() => introSkyDelays());
  return (
    <div className={className ? `intro-sky ${className}` : 'intro-sky'} data-phase={phase} data-light={light} style={delays as CSSProperties} aria-hidden="true">
      <div className="intro-haze" />
      <div className="intro-clouds">
        <div className="intro-clouds-a" />
        <div className="intro-clouds-b" />
      </div>
    </div>
  );
}
