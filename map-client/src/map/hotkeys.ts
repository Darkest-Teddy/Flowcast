// Keyboard flying, after Google Maps and Google Earth: arrows pan, Shift+arrows rotate and tilt,
// + and - zoom. Pure camera math here; MapHotkeys.tsx owns the listeners and the shortcuts sheet.
import type { CameraState } from './basemap';

/** Screen pixels per second for a held arrow key. */
export const PAN_SPEED = 700;
/** Degrees per second for a held Shift+arrow (or Q / E). */
export const ROTATE_SPEED = 90;
export const TILT_SPEED = 45;
/** Zoom levels per second for a held + or -. */
export const ZOOM_SPEED = 1.6;
/** A tap still moves this long, so one press is a visible step rather than a twitch. */
export const MIN_HOLD_MS = 160;

// Mapbox and MapLibre use 512px tiles: metres per pixel at zoom 0 on the equator.
const METRES_PER_PIXEL_Z0 = 40075016.686 / 512;
const METRES_PER_DEGREE_LAT = 111320;

export interface Motion {
  /** Screen pan, in pixels: +x right, +y up. */
  panX: number;
  panY: number;
  rotate: number; // degrees, + clockwise
  tilt: number; // degrees, + toward the horizon
  zoom: number; // zoom levels
}

/**
 * The camera after moving by `motion`. A screen pan follows the bearing, and the ground in a
 * tilted view runs away from the camera, so a pan "up" covers more ground the steeper the tilt.
 */
export function applyMotion(camera: CameraState, motion: Motion, maxPitch: number): CameraState {
  const [lng, lat] = camera.center;
  const metresPerPixel = (METRES_PER_PIXEL_Z0 * Math.cos((lat * Math.PI) / 180)) / 2 ** camera.zoom;
  const stretch = 1 / Math.max(Math.cos((camera.pitch * Math.PI) / 180), 0.35);
  const right = motion.panX * metresPerPixel;
  const up = motion.panY * metresPerPixel * stretch;
  const b = (camera.bearing * Math.PI) / 180;
  const east = right * Math.cos(b) + up * Math.sin(b);
  const north = -right * Math.sin(b) + up * Math.cos(b);
  return {
    center: [
      lng + east / (METRES_PER_DEGREE_LAT * Math.cos((lat * Math.PI) / 180)),
      lat + north / METRES_PER_DEGREE_LAT,
    ],
    zoom: camera.zoom + motion.zoom,
    pitch: Math.min(Math.max(camera.pitch + motion.tilt, 0), maxPitch),
    bearing: camera.bearing + motion.rotate,
  };
}

/** What a held key does per second, or null when it isn't a flying key. Shift turns arrows into look-around. */
export function keyMotion(key: string, shift: boolean): Partial<Motion> | null {
  switch (key) {
    case 'ArrowLeft': return shift ? { rotate: -ROTATE_SPEED } : { panX: -PAN_SPEED };
    case 'ArrowRight': return shift ? { rotate: ROTATE_SPEED } : { panX: PAN_SPEED };
    case 'ArrowUp': return shift ? { tilt: TILT_SPEED } : { panY: PAN_SPEED };
    case 'ArrowDown': return shift ? { tilt: -TILT_SPEED } : { panY: -PAN_SPEED };
    case 'q': case 'Q': return { rotate: -ROTATE_SPEED };
    case 'e': case 'E': return { rotate: ROTATE_SPEED };
    case '+': case '=': case 'PageUp': return { zoom: ZOOM_SPEED };
    case '-': case '_': case 'PageDown': return { zoom: -ZOOM_SPEED };
    default: return null;
  }
}

/** The shortcuts sheet's contents, in reading order. Keys flying the camera live in keyMotion above. */
export const HOTKEY_GROUPS: { title: string; keys: { keys: string[]; label: string }[] }[] = [
  {
    title: 'Move',
    keys: [
      { keys: ['←', '↑', '→', '↓'], label: 'Pan the map (hold to keep going)' },
      { keys: ['+', '−'], label: 'Zoom in / out (also Page Up / Page Down)' },
      { keys: ['Home'], label: 'Back to this campus’s starting view (also 0)' },
      { keys: ['C'], label: 'Next campus' },
    ],
  },
  {
    title: 'Look around',
    keys: [
      { keys: ['Shift', '← →'], label: 'Rotate' },
      { keys: ['Shift', '↑ ↓'], label: 'Tilt toward the horizon / top-down' },
      { keys: ['Q', 'E'], label: 'Rotate left / right' },
      { keys: ['[', ']'], label: 'Rotate 45° left / right' },
      { keys: [',', '.'], label: 'Tilt a step down / up' },
      { keys: ['N'], label: 'Face north' },
      { keys: ['U'], label: 'Look straight down' },
      { keys: ['1', '2', '3'], label: 'Bird’s-eye, 3D, street level' },
      { keys: ['R'], label: 'Spin' },
      { keys: ['T'], label: 'Tour the landmarks' },
    ],
  },
  {
    title: 'Screen',
    keys: [
      { keys: ['/'], label: 'Ask about campus' },
      { keys: ['H'], label: 'Hide or show the interface' },
      { keys: ['F'], label: 'Full screen' },
      { keys: ['W'], label: 'Cycle the weather' },
      { keys: ['P'], label: 'Performance readout' },
      { keys: ['?'], label: 'Show or hide these shortcuts' },
    ],
  },
];
