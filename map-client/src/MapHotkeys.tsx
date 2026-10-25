// Keyboard shortcuts for flying around the map (map/hotkeys.ts), and the sheet listing them,
// hidden until ? is pressed. The older single keys (R, [ ], , ., H, W, P) stay with their owners
// and are only listed here.
import { useEffect, useRef, useState } from 'react';
import type { Basemap } from './map/basemap';
import type { CameraController, ViewPreset } from './map/camera';
import { applyMotion, HOTKEY_GROUPS, keyMotion, MIN_HOLD_MS, type Motion } from './map/hotkeys';
import './hotkeys.css';

interface Props {
  basemap: Basemap | null;
  camera: CameraController | null;
  /** Fly to the current campus's starting view. */
  onHome: () => void;
  /** Fly to the next campus. */
  onNextCampus: () => void;
}

const PRESET_KEYS: Record<string, ViewPreset> = { '1': 'top', '2': '3d', '3': 'street' };

/** A key meant for a field, not the map. */
function typing(e: KeyboardEvent): boolean {
  const t = e.target instanceof HTMLElement ? e.target : null;
  return !!t && (t.isContentEditable || /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName));
}

// Controls that already use the arrows (the sheet's grabber, tabs, menus) keep them.
const ARROW_OWNERS = '[aria-keyshortcuts], [role="tab"], [role="tablist"], [role="slider"], [role="listbox"], [role="option"], [role="menu"], [role="menuitem"], [role="radiogroup"], [role="radio"]';
const arrowOwned = (e: KeyboardEvent) =>
  e.key.startsWith('Arrow') && e.target instanceof Element && !!e.target.closest(ARROW_OWNERS);

export function MapHotkeys({ basemap, camera, onHome, onNextCampus }: Props) {
  const [open, setOpen] = useState(false);
  const latest = useRef({ basemap, camera, onHome, onNextCampus });
  latest.current = { basemap, camera, onHome, onNextCampus };

  useEffect(() => {
    // Held keys and when each went down; a released key keeps moving until MIN_HOLD_MS has passed.
    const held = new Map<string, { shift: boolean; since: number; released: boolean }>();
    let frame = 0;
    let last = 0;

    // Keys take the camera from the spin and the tour, as dragging the map does.
    const takeCamera = () => {
      const { camera } = latest.current;
      if (!camera) return;
      if (camera.getState().touring) camera.toggleTour();
      if (camera.getState().spinning) camera.setSpinning(false);
    };

    const tick = (now: number) => {
      const map = latest.current.basemap;
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      const motion: Motion = { panX: 0, panY: 0, rotate: 0, tilt: 0, zoom: 0 };
      for (const [key, h] of held) {
        if (h.released && now - h.since >= MIN_HOLD_MS) { held.delete(key); continue; }
        const m = keyMotion(key, h.shift);
        if (!m) continue;
        motion.panX += (m.panX ?? 0) * dt;
        motion.panY += (m.panY ?? 0) * dt;
        motion.rotate += (m.rotate ?? 0) * dt;
        motion.tilt += (m.tilt ?? 0) * dt;
        motion.zoom += (m.zoom ?? 0) * dt;
      }
      if (map && !map.isEasing()) map.jumpTo(applyMotion(map.getCamera(), motion, map.maxPitch));
      frame = held.size ? requestAnimationFrame(tick) : 0;
    };

    const onDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || typing(e)) return;
      const { basemap, camera, onHome, onNextCampus } = latest.current;

      if (e.key === '?') { e.preventDefault(); setOpen((o) => !o); return; }
      if (e.key === 'Escape') { setOpen(false); return; }
      if (e.key === '/') {
        const ask = document.querySelector<HTMLInputElement>('.hud-ask .ask-form input');
        if (ask) { e.preventDefault(); ask.focus(); }
        return;
      }
      if (!basemap) return;

      if (keyMotion(e.key, e.shiftKey) && !arrowOwned(e)) {
        // Arrows on the focused canvas would also fire the map's own keyboard handler; this one owns them.
        e.preventDefault();
        e.stopPropagation();
        if (e.repeat && held.has(e.key)) return;
        takeCamera();
        held.set(e.key, { shift: e.shiftKey, since: performance.now(), released: false });
        if (!frame) { last = performance.now(); frame = requestAnimationFrame(tick); }
        return;
      }

      const single: Record<string, () => void> = {
        n: () => camera?.northUp(),
        u: () => camera?.applyPreset('top'),
        t: () => camera?.toggleTour(),
        c: () => { takeCamera(); onNextCampus(); },
        f: () => {
          if (document.fullscreenElement) void document.exitFullscreen();
          else void document.documentElement.requestFullscreen?.();
        },
        '0': () => { takeCamera(); onHome(); },
        Home: () => { takeCamera(); onHome(); },
      };
      const preset = PRESET_KEYS[e.key];
      const action = preset ? () => camera?.applyPreset(preset) : single[e.key.length === 1 ? e.key.toLowerCase() : e.key];
      if (!action) return;
      e.preventDefault();
      action();
    };

    const onUp = (e: KeyboardEvent) => {
      // Shift released mid-hold: the arrow keeps its meaning until it is let go.
      const h = held.get(e.key);
      if (h) h.released = true;
    };
    const releaseAll = () => held.forEach((h) => { h.released = true; });

    // Capture, so a focused map canvas never sees the arrows first.
    window.addEventListener('keydown', onDown, true);
    window.addEventListener('keyup', onUp, true);
    window.addEventListener('blur', releaseAll);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('keydown', onDown, true);
      window.removeEventListener('keyup', onUp, true);
      window.removeEventListener('blur', releaseAll);
    };
  }, []);

  if (!open) return null;
  return (
    <div className="hotkeys-backdrop" onPointerDown={(e) => { if (e.target === e.currentTarget) setOpen(false); }}>
      <section className="hotkeys" role="dialog" aria-modal="false" aria-labelledby="hotkeys-title">
        <header className="hotkeys-head">
          <h2 id="hotkeys-title">Keyboard shortcuts</h2>
          <button type="button" className="hotkeys-close" onClick={() => setOpen(false)} aria-label="Close shortcuts">Esc</button>
        </header>
        <div className="hotkeys-groups">
          {HOTKEY_GROUPS.map((group) => (
            <div key={group.title} className="hotkeys-group">
              <h3>{group.title}</h3>
              <dl>
                {group.keys.map((row) => (
                  <div key={row.label} className="hotkeys-row">
                    <dt>{row.keys.map((k) => <kbd key={k}>{k}</kbd>)}</dt>
                    <dd>{row.label}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
