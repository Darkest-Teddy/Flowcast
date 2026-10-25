// The map's view of the shared crowd scale (theme/crowd.ts, the one definition). Kept free of
// rendering imports so the Ask server can use it too. The import is relative on purpose: the
// `@theme` alias exists only in the web app's Vite config, not here, in the tests or the server.
import { CROWD_LEVELS, crowdLevel, type CrowdKey, type CrowdLevelInfo } from '../../../theme/crowd';

export { crowdLevel, type CrowdKey, type CrowdLevelInfo };

/** Lowest level first, the order the legend and the scale itself are written in. */
export { CROWD_LEVELS };

// One scale for the whole UI: the map glow, the tags and the dashboard bars always agree.
// `glow` is the light colour; `text` is its pale twin, which keeps 4.5:1 or better on the dark
// glass of the tags and panel (5.1:1 worst case, over a white map; checked by the crowd tests).
/** Highest level first, as the map has always listed them. */
export const LEVELS: readonly CrowdLevelInfo[] = [...CROWD_LEVELS].reverse();
