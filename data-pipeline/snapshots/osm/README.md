# Campus walking corridors

OpenStreetMap map API extracts retrieved October 24, 2026. The gzip files preserve the complete original XML responses, including node IDs, way IDs and access tags. © OpenStreetMap contributors; [ODbL 1.0](https://www.openstreetmap.org/copyright).

- `corridor.osm.gz`: https://api.openstreetmap.org/api/0.6/map?bbox=-71.112,42.3447,-71.102,42.3472
- `bridge.osm.gz`: https://api.openstreetmap.org/api/0.6/map?bbox=-71.1135,42.3501,-71.1065,42.3553
- `link.osm.gz`: https://api.openstreetmap.org/api/0.6/map?bbox=-71.1115,42.3433,-71.102,42.3496

Run `python3 data-pipeline/build_cross_campus_routes.py --rebuild-source` from the repository root to normalize these cached extracts and merge routes into `demo-day.json`. No network requests are made. Existing routes are preserved except shorter verified DeWolfe routes; Fenway–Charles River pairs are added. Connections require exactly matching coordinates at the existing six-decimal precision. Transit-stop snap segments are excluded. Cycleways require explicit pedestrian permission; private or prohibited walking ways are excluded.

The graph follows OSM pedestrian access and way adjacency; it does not evaluate turn restrictions, opening hours, temporary closures or accessibility suitability.
