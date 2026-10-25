// When the browser takes the map's WebGL context away for good, the map is gone: the canvas stays
// blank while the HTML panels carry on, and nothing on screen says why. iOS Safari does this when
// a page asks for more graphics memory than the phone will give it.
//
// Not every loss is that. A page being left loses its context on the way out, a removed map gives
// its context up on purpose, and iOS takes the
// context from a tab in the background and hands it back when the tab returns (the map restores
// itself then). So a loss counts only if the page is staying, and only once it has had a few
// seconds in view to be restored. Then the first one switches to Speed (pixel ratio 1, every
// optional layer off; remembered like the perf monitor's own switch) and reloads. A loss in Speed
// has no lighter step to take, so the map says so instead of reloading in a loop.
import { quality } from './quality';

/** How long a visible page waits for the browser to hand a lost context back. */
const RESTORE_WAIT_MS = 4000;
/** Set for this tab once a loss has reloaded it, so a link that forces ?quality= can't loop. */
const RELOADED_KEY = 'flowcast.contextLostReload';

let leaving = false;
window.addEventListener('pagehide', () => { leaving = true; });
window.addEventListener('beforeunload', () => { leaving = true; });

function reloadedAlready(): boolean {
  try {
    if (sessionStorage.getItem(RELOADED_KEY)) return true;
    sessionStorage.setItem(RELOADED_KEY, '1');
    return false;
  } catch {
    return true; // can't remember a reload: never risk a loop
  }
}

/** Resolves true if the context comes back within RESTORE_WAIT_MS of the page being visible. */
function restoredSoon(canvas: HTMLCanvasElement): Promise<boolean> {
  return new Promise((resolve) => {
    let timer = 0;
    const done = (restored: boolean) => {
      window.clearTimeout(timer);
      canvas.removeEventListener('webglcontextrestored', onRestored);
      document.removeEventListener('visibilitychange', onVisible);
      resolve(restored);
    };
    const onRestored = () => done(true);
    const startClock = () => { timer = window.setTimeout(() => done(false), RESTORE_WAIT_MS); };
    const onVisible = () => {
      if (document.hidden) return;
      document.removeEventListener('visibilitychange', onVisible);
      startClock();
    };
    canvas.addEventListener('webglcontextrestored', onRestored);
    if (document.hidden) document.addEventListener('visibilitychange', onVisible);
    else startClock();
  });
}

function showNote(container: HTMLElement) {
  if (container.querySelector('.map-lost')) return;
  const note = document.createElement('div');
  note.className = 'map-lost';
  note.setAttribute('role', 'alert');
  note.innerHTML =
    '<p class="map-lost-title">The 3D map needs more graphics memory than this device has free.</p>' +
    '<p>Close other tabs or apps, then reload. The panels and forecasts still work.</p>' +
    '<button type="button">Reload</button>';
  note.querySelector('button')!.addEventListener('click', () => window.location.reload());
  container.appendChild(note);
}

export function watchContextLoss(canvas: HTMLCanvasElement, container: HTMLElement) {
  canvas.addEventListener('webglcontextlost', async (event) => {
    event.preventDefault(); // lets the browser hand the context back if it can
    // A map that was removed (an unmount, or React's development double mount) gives its context
    // up on purpose; only the canvas still on the page is the map.
    if (leaving || !canvas.isConnected) return;
    if (await restoredSoon(canvas)) return;
    if (leaving || !canvas.isConnected) return;
    if (quality.mode !== 'speed' && !reloadedAlready()) {
      quality.setMode('speed');
      window.location.reload();
      return;
    }
    showNote(container);
  });
}
