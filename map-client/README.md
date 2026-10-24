# map-client (React + TypeScript)

Owner: 3D Map / Frontend Lead (see `.plans/campus-digital-twin-spec.md` Section 2).

The big-screen 3D campus view.

## What goes here
- Mapbox GL JS (Standard style) base map, real BU buildings extruded from OSM data (Section 6.1–6.2)
- deck.gl layers: `ScenegraphLayer` for agents (Kenney Mini Characters, Section 7.1), `TextLayer` for name labels, `HeatmapLayer` for crowd density (Section 6.3–6.4)
- Side dashboard: time-series charts per location (Section 3.3)
- Click-to-inspect building stats
- Scrub-through week timeline
- Building-interior view: tap a building → show its interior template populated with the Kenney characters currently inside it, optionally with the holographic shader upgrade (Section 6.7)

Needs a free Mapbox access token — see Section 6.1 and the kickoff checklist.
