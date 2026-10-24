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
