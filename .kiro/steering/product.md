---
inclusion: always
---

# Flowcast product

Flowcast is a browser-based 3D model of the BU campus for the DS+X hackathon (Hack College track, 24–25 October 2026). Student agents follow schedules; phones join live via QR code.

- Every number the simulation uses is a stated assumption, not a measurement of real BU students. Say "projection" or "model-derived", never "prediction" or "accuracy".
- The full plan is `.plans/campus-digital-twin-spec.md`. When it conflicts with older code, the plan wins.
- Judging weights: Problem 20%, Idea & Relevance 25%, Technical Execution 25%, Design 15%, Responsibility & Ethics 10%, Presentation 5%.
- Personal data (names, schedules, fatigue scores) stays in the owner's session. Nothing about an individual is shown on the shared display beyond their avatar.

## Data honesty, users and privacy

### Honesty about data (non-negotiable)

- Keep published evidence and model assumptions separate, and label which is which in code, data and UI.
- Registrations, seats and capacities are never attendance or occupancy.
- Never invent a venue, coordinate, capacity or schedule. Unresolvable records stay unmapped and are shown as such.
- Every scraped value keeps its provenance (source URL, retrieval time, checksum).
- Assumptions are named constants with a plain-language entry in the simulation's `assumptions` list.
- Capacities keep their published or configured basis; never enlarge them to fit predicted counts.
- Random choices are stable hashes keyed by student, activity and (for events) event ID, so one change never reshuffles unrelated students.

### Users and accessibility

- Students use the dashboard (`web/`) and the map (`/map`); admins use `/admin`; audience members join from phones.
- Crowd levels always pair colour with a word, a percentage and a people icon (Quiet, Busy, Packed). Text keeps 4.5:1 contrast.
- Controls are real buttons or inputs with labels.

### Privacy

- No login-only, private or personal data is scraped. Private events are skipped, not parsed.
