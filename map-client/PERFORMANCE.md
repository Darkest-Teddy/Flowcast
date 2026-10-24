# Map trail profiling

Measured October 24, 2026 in the collaborative Chromium browser on Apple M3 Max,
1280 × 800 CSS pixels, 2× rendering, Quality mode. Development server URL:
`http://localhost:5173/?at=12:15&speed=1&spin=0`.

The pedestrian TripsLayer previously submitted 102,616 trips and 6,569,392 path
points for the entire Wednesday. Most were invisible at the displayed time but
still incurred GPU work. Playback now unions its existing five-minute walking
buckets over the visible trail interval. Candidate arrays remain stable while the
bucket bounds are unchanged; the shader still clips to the precise time. Recently
completed walks remain included until their trails fade. Simulation counts,
positions, timing, and graphics quality are unchanged.

For the comparison, playback was paused at 44,110.5946 seconds with the default
camera (zoom 15.6, pitch 58, bearing -110). A temporary browser-only wrapper around
`__flowcast.overlay.setProps` switched the `flow-trails` layer between its optimized
data and `layer.clone({data: __flowcast.playback.data.trips})`. No layers were hidden.
Each sample collected requestAnimationFrame intervals for eight seconds after
one to two seconds of warmup. Optimized/full/optimized order gave:

- Optimized: 43.70 ms mean, 50.10 ms p95.
- Full-day data: 87.54 ms mean, 141.90 ms p95.
- Optimized repeat: 42.96 ms mean, 50.10 ms p95.

The optimized window contained 5,894 trips and 404,509 points (93.8% fewer points).
These are local frame-interval measurements, not GPU timer queries or a production
device guarantee. Other drawing and browser work remains; this scene is still
about 23 FPS. Crossing bucket boundaries uploads a new candidate set and was not
included in this fixed-time comparison. Playback tests cover boundary selection,
long trips, fading trails, speed changes, backward scrubbing, and stable identity.

Validation: `node --test tests/playback.test.mjs`, `npm run typecheck`, and
`npx vite build` passed. The full `npm test` run had 70 passing and three failing
tests: two population/housing expectations (6306 vs 6906, 461 vs 595), and the
scale test's unmodeled-location expectation (1 vs 0). The checkout had ongoing
population/data changes; this optimization does not modify those expectations.
Vite reported its existing configuration-loader and large-bundle warnings.

## Material, occupancy, and label follow-up

The follow-up keeps the same scene content and adds three optimizations:

- Compatible opaque glTF primitives share a draw, with base color, metallic,
  roughness and emissive factors stored per vertex. The ScenegraphLayer subclass
  applies these before PBR lighting. Animated, transparent and unsupported assets
  retain their original primitives. Charles River buildings go from 47 primitives
  to 2, each transit vehicle from 16 to 1, and sailboats from 11 to 1.
- Nonoverlapping stays use sorted per-location start/end events for occupancy.
  Overlapping stays retain the original first-match scan. The index matches
  166,552 Wednesday event boundaries, including reverse scrubbing.
- Building and place tags cache roof projections while camera, padding, viewport,
  source snapshot and roof data remain unchanged. Placement and selection still
  update each frame.

Measurements used the same Chromium/M3 Max, fixed 1280×800 viewport, Mapbox,
Wednesday's current 92,140 trips, default camera and 1× playback at 12:15.
These are development-browser measurements; population data changed since the
older trail experiment above, so those numbers are not a paired baseline.

| Configuration | Average FPS | 1% low FPS |
| --- | ---: | ---: |
| Quality, batching disabled | 22.77 | 17.10 |
| Quality, final changes | 33.72 | 21.82 |
| Speed, before label cache | 39.95 | 24.39 |

Each row is a 10-second rAF sample after loading and warmup. The first two cover
approximately simulation seconds 44107–44117. Other warmed Quality samples were
32.6–32.9 FPS, with 16.7–20.8 FPS 1% lows. Thus **60 FPS / 30 FPS 1% lows is not
achieved**. Short samples and variable GC/browser scheduling make lows noisy;
these are not production guarantees. No long frames within a valid sample were
removed. Background/throttled preview runs were discarded as whole samples.

Instrumentation measured deck draws at roughly 9.4 ms per frame after batching,
versus 20.7 ms before. Mapbox's render call including deck still took 20.6 ms per
frame, already above the 16.7 ms total budget. Removing panel blur and reducing
pixel ratio alone did not resolve the remaining CPU cost. Further work should
profile Mapbox style passes and deck draw submission in a foreground production
build before changing visual detail or renderer architecture.

To reproduce, open `/?at=12:15&speed=1&spin=0&quality=quality`, wait for models and
tiles, paste `scripts/profile-frames.js` into the development browser console,
and run `await profileFrames({duration: 10000, warmup: 1000})`. Use
`&batchMaterials=0` for the unbatched control. Keep camera, viewport, dataset,
quality and playback time comparable. Longer foreground runs are recommended;
the collaborative preview's evaluate call times out at 15 seconds and an idle
preview can throttle even when document visibility reports visible.

Verification: `npm test`, `npm run typecheck`, and `npx vite build`. Material tests
check geometry and per-triangle factors, plus compatibility with the installed
PBR shader. Projection tests cover camera/padding/resize/source invalidation.
