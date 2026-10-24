# Design: real campus events

## Data flow

```text
scrape_events.py ──> output/events.json (+ manifest checksum)
        │
build_map_data.py ──> public/data/campus-data.json  events[]: locationId, roomCode, roomCapacity, organizer
        │
map-client/src/sim/gatherings.ts   events for a date -> Gathering[] (window, venue, seat cap, projected?)
        │
sourceDay.ts buildSourceDay(base, data, weekday, { eventDate })
        │            └─ no eventDate = baseline; eventDate = that date's gatherings
        ├─> map (App.tsx): Playback of the event day
        └─> scripts/build-event-impact.mjs ──> public/data/event-impact.json
                                                  └─> web api.ts ──> Events page, Event impact tab
```

## Key decisions

- **Venue resolution is name-first.** Terrier Central fills 775 Commonwealth Ave for many rooms in other buildings, so the address only decides when the name names no building.
- **Gatherings live in the planner, not the renderer.** They become ordinary stays and trips, so the glow, tags, counts and trails all change without renderer work, and existing invariants still apply.
- **Baseline vs events is a paired run.** Same population, same weekly enrollment and the same hashed choices; only the gathering step differs. Differences are attributable to the events under the model's assumptions, not proof of real-world impact (spec 5.8).
- **Access during an event.** A published event window counts as access evidence for its venue, including restricted venues such as Agganis Arena.
- **Projection.** Simulated days always use representative-week classes and hours; an event's own date only selects which events run.
- **Precomputed impact.** The dashboard can't run a 37,000-student simulation per click, so a build script writes hourly mean occupancy per place for seven weekday baselines and every date with mapped events.
- **Day cache.** Built days are cached per weekday and event date (LRU of 4), since each day holds every student's trips.

## Assumptions (exposed in `GATHERING_ASSUMPTIONS`)

Attendance probability 25%, seat caps, 120-minute default duration, 6-hour limit, projection, one event per student per day, commuters only on class days.
