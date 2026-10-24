# Requirements: real campus events on the map and dashboard

## Introduction

Bring BU's published future campus events into Flowcast. Events appear on the dashboard, change crowding on the 3D map, and a new dashboard tab lets a person pick a date and compare each place's predicted crowding with and without that day's events. Event behavior follows the Gathering family in `.plans/campus-digital-twin-spec.md` Section 5.6.

## Requirement 1: Collect every public upcoming event

**User story:** As a student, I want Flowcast to know about all public campus events, so that forecasts reflect what's actually happening.

1. WHEN the events collector runs THEN it SHALL page through the full public Terrier Central listing (default limits: 500 events, 25 listing pages).
2. WHEN a listed event redirects to a sign-in page THEN the collector SHALL skip it and report a count of private events as a warning, not an error.
3. WHEN an event page's JSON-LD contains raw newlines or stray backslashes THEN the collector SHALL still parse it.
4. The collector SHALL keep provenance for every event and SHALL NOT store registrations as attendance.

## Requirement 2: Resolve venues only to mapped buildings

1. WHEN an event names a mapped building or room ("CAS B36", "Student Theater at Agganis Arena") THEN the build SHALL resolve it to that location, even if the listing's address is the organizer's default.
2. WHEN the name names no building THEN a known venue address MAY resolve it.
3. IF a venue is hidden, unmapped (for example the Howard Thurman Center) or ambiguous THEN the event SHALL stay unmapped and SHALL NOT borrow a nearby building.
4. WHEN an event names a room with a published seat count THEN the bundle SHALL carry that room code and seat count.

## Requirement 3: Events change the map (Gathering behavior)

1. WHEN a day is simulated with an event date THEN each mapped event that day SHALL draw students who are free for its whole window, on its campus, and able to walk there and back in time.
2. Each eligible student SHALL attend with a tunable probability (default 25%), chosen by a stable hash of student and event ID.
3. Attendance SHALL be capped by the named room's published seats (24 if unlisted) or, for whole-venue events, the venue's modeled capacity. Capacities SHALL NOT be enlarged.
4. Gatherings SHALL rank after fixed class commitments and before discretionary meals, study and gym visits. Published class times SHALL NOT move.
5. A student SHALL attend at most one event per day; commuters SHALL only attend on days they have mapped classes.
6. Events without an end SHALL last 120 minutes; listings longer than 6 hours SHALL NOT be simulated.
7. WHEN a day is simulated without an event date THEN the output SHALL be the unchanged no-event baseline.
8. The map SHALL use real dates inside the representative week; events from other weeks SHALL be projected onto the same weekday and time and labelled "projected".

## Requirement 4: Dashboard Events page uses real data

1. The Events page SHALL list scraped future events grouped by day, through `api.ts` only.
2. Each event SHALL show its venue, or "Location not public" / "Not on the map" when it can't affect crowding.

## Requirement 5: Event-impact tab with a date picker

1. The dashboard SHALL have a tab where a person picks a date from a calendar.
2. FOR the picked date the tab SHALL list that day's events and, for each place, hourly crowding without events and with events, plus the difference.
3. The tab SHALL say when the date's events are projected onto the representative week, and SHALL list the model assumptions.

## Requirement 6: Verification

1. Python and map-client test suites SHALL pass; TypeScript SHALL typecheck in `map-client` and `web`.
2. Property tests SHALL check, across generated event days, that every student is accounted for at every second, attendance never exceeds its cap, class assignments are identical to the baseline, and baseline days are unchanged.
