// Spin, rotate, tilt, view presets and the landmark tour (logic in map/camera.ts), in the floating
// toolbar.
// Keyboard, while focus isn't in a form control: R spin, [ ] rotate, , . tilt.
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { Basemap } from './map/basemap';
import { CameraController, PRESETS, pickLandmarks, shouldAutoSpin, type CameraControllerState, type ViewPreset } from './map/camera';
import type { CampusLocation } from './sim/playback';
import { Popover } from './Popover';

interface Props {
  basemap: Basemap | null;
  /** The current campus's locations; the tour visits a handful of them. */
  locations: CampusLocation[];
  /** The intro's camera moves are still running: the spin on load waits for them. */
  intro?: boolean;
  /** Hands the camera to the HUD's rotate buttons (null when the map goes away). */
  onController?: (controller: CameraController | null) => void;
}

const IDLE: CameraControllerState = { spinning: false, touring: false, preset: null, landmark: null };
const noopSubscribe = () => () => {};

export function CameraControls({ basemap, locations, intro = false, onController }: Props) {
  const [camera, setCamera] = useState<CameraController | null>(null);

  useEffect(() => {
    if (!basemap) return;
    const controller = new CameraController(basemap);
    setCamera(controller);
    onController?.(controller);
    if (import.meta.env.DEV) Object.assign(window, { __flowcastCamera: controller });
    return () => {
      controller.dispose();
      setCamera(null);
      onController?.(null);
    };
  }, [basemap, onController]);

  // Spin on load, once the intro has flown in (both would turn the camera).
  useEffect(() => {
    if (camera && !intro && shouldAutoSpin()) camera.autoStart();
  }, [camera, intro]);

  const state = useSyncExternalStore(camera?.subscribe ?? noopSubscribe, camera?.getState ?? (() => IDLE));

  // `locations` is rebuilt on every HUD refresh; only re-pick when the set of places changes.
  const key = locations.map((l) => l.id).sort().join('|');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const landmarks = useMemo(() => pickLandmarks(locations), [key]);
  useEffect(() => camera?.setLandmarks(landmarks), [camera, landmarks]);

  useEffect(() => {
    if (!camera) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName))) return;
      const action = {
        r: () => camera.toggleSpin(),
        R: () => camera.toggleSpin(),
        '[': () => camera.rotateLeft(),
        ']': () => camera.rotateRight(),
        ',': () => camera.tiltDown(),
        '.': () => camera.tiltUp(),
      }[e.key];
      if (!action) return;
      e.preventDefault();
      action();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [camera]);

  if (!camera) return null;

  // In the floating toolbar: Spin on its own (the one people reach for), the rest in a popover.
  return (
    <>
      <button className="tool" onClick={() => camera.toggleSpin()} aria-pressed={state.spinning} aria-label="Spin the view" title="Spin (R)">
        <SpinIcon /> <span className="tool-word">Spin</span>
      </button>
      <Popover title="View" hint="Rotate, tilt, view presets and the landmark tour" label={<><CameraIcon /> <span className="tool-word">View</span></>}>
        <div className="camera-grid">
          <button className="span-2" onClick={() => camera.rotateLeft()} aria-label="Rotate left 45 degrees" title="Rotate left ([)">
            <RotateIcon flip />
          </button>
          <button className="span-2" onClick={() => camera.northUp()} aria-label="North up" title="North up">
            <NorthIcon /> N
          </button>
          <button className="span-2" onClick={() => camera.rotateRight()} aria-label="Rotate right 45 degrees" title="Rotate right (])">
            <RotateIcon />
          </button>

          <button className="span-3" onClick={() => camera.tiltDown()} aria-label="Tilt toward top-down" title="Tilt down (,)">
            <TiltIcon down /> Less tilt
          </button>
          <button className="span-3" onClick={() => camera.tiltUp()} aria-label="Tilt toward the horizon" title="Tilt up (.)">
            <TiltIcon /> More tilt
          </button>

          {(Object.keys(PRESETS) as ViewPreset[]).map((p) => (
            <button key={p} className="span-2 preset" onClick={() => camera.applyPreset(p)} aria-pressed={state.preset === p} aria-label={`${PRESETS[p].label} view`}>
              {p === 'top' ? 'Top' : p === '3d' ? '3D' : 'Street'}
            </button>
          ))}

          <button
            className="span-6"
            onClick={() => camera.toggleTour()}
            aria-pressed={state.touring}
            aria-label="Tour campus landmarks"
            disabled={!landmarks.length}
            title="Fly between landmarks"
          >
            <TourIcon /> Tour landmarks
          </button>
        </div>
        <p className="camera-status" aria-live="polite">
          {state.touring ? `Touring · ${state.landmark ?? '…'}` : state.spinning ? 'Spinning · drag to stop' : 'R spin · [ ] rotate · , . tilt'}
        </p>
      </Popover>
    </>
  );
}

const svg = { width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const;

function SpinIcon() {
  return (
    <svg {...svg}>
      <ellipse cx="12" cy="12" rx="9" ry="4.5" />
      <path d="M17 6.5l3 1.5-1.5 3" />
    </svg>
  );
}

function CameraIcon() {
  // A compass rose: the view's heading and tilt.
  return (
    <svg {...svg}>
      <circle cx="12" cy="12" r="9" />
      <path d="M14.8 9.2l-1.9 4.7-3.7 1.9 1.9-4.7z" fill="currentColor" fillOpacity="0.25" />
    </svg>
  );
}

function TourIcon() {
  return (
    <svg {...svg}>
      <path d="M12 21s-6-5.3-6-10a6 6 0 0 1 12 0c0 4.7-6 10-6 10z" />
      <circle cx="12" cy="11" r="2.2" />
    </svg>
  );
}

function RotateIcon({ flip }: { flip?: boolean }) {
  return (
    <svg {...svg} style={flip ? { transform: 'scaleX(-1)' } : undefined}>
      <path d="M20 12a8 8 0 1 1-3-6.2" />
      <path d="M20 4v5h-5" />
    </svg>
  );
}

function NorthIcon() {
  return (
    <svg {...svg}>
      <path d="M12 3l5 16-5-4-5 4z" fill="currentColor" fillOpacity="0.25" />
    </svg>
  );
}

function TiltIcon({ down }: { down?: boolean }) {
  // A plane seen flat (down) or steep (up).
  return (
    <svg {...svg}>
      {down ? <path d="M3 9h18l-2 8H5z" /> : <path d="M7 6h10l4 12H3z" />}
    </svg>
  );
}
