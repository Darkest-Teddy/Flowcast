# Flowcast product rules

Flowcast is a browser-based 3D digital twin of Boston University's campuses. Simulated students follow published class schedules and stated behavioral assumptions; the map and dashboard show projected crowding by building and hour.

## Honesty about data (non-negotiable)

- Keep published evidence and model assumptions separate, and label which is which in code, data and UI.
- Registrations, seats and capacities are never attendance or occupancy.
- Never invent a venue, coordinate, capacity or schedule. Unresolvable records stay unmapped and are shown as such.
- Every scraped value keeps its provenance (source URL, retrieval time, checksum).
- Assumptions are named constants with a plain-language entry in the simulation's `assumptions` list.
- Capacities keep their published or configured basis; never enlarge them to fit predicted counts.
- Random choices are stable hashes keyed by student, activity and (for events) event ID, so one change never reshuffles unrelated students.

## Users and accessibility

- Students use the dashboard (`web/`) and the map (`/map`); admins use `/admin`; audience members join from phones.
- Crowd levels always pair colour with a word and a percentage (Quiet, Moderate, Busy, Packed). Text keeps 4.5:1 contrast.
- Controls are real buttons or inputs with labels.

## Privacy

- No login-only, private or personal data is scraped. Private events are skipped, not parsed.
