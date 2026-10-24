# Flowcast

A live, browser-based 3D model of the BU campus, filled with AI agents that follow real class schedules. It predicts crowding and movement across a full week, and lets people join live from their phones via a QR code.

Built for **DS+X**, Boston University's 24-hour data science hackathon (Hack College track), October 24–25, 2026.

## Read this first

The full project plan lives in [`.plans/campus-digital-twin-spec.md`](.plans/campus-digital-twin-spec.md). It covers:
- Team roles and the hour-by-hour build schedule
- The 3D rendering approach (Mapbox GL JS + deck.gl) and why
- The simulation and crowd-prediction ML architecture
- The realtime backend design
- Privacy, ethics, bias, and accessibility commitments
- How the plan maps to the published judging rubric

The on-site kickoff checklist is in [`.plans/kickoff-checklist.md`](.plans/kickoff-checklist.md) — start there on Saturday morning.

## Repo layout

```
/data-pipeline   Python: OSM extraction, synthetic schedule generator, crowd-prediction ML model
/server          Node.js + TypeScript: the realtime Socket.IO server, the single source of live state
/map-client      React + TypeScript: the big-screen 3D campus view (Mapbox GL JS + deck.gl)
/mobile          React + TypeScript: the phone-facing QR web app (persona builder, follow-your-agent, voting)
```

Each folder gets its own `package.json`/`requirements.txt` as its owner scaffolds it — see the plan's Hour 0–1 block for who owns what.
