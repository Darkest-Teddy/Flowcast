# Study-spot catalog

`web/src/data/studySpots.ts` records seven study spaces checked against official BU pages on 2026-10-25. Each entry links to its room-specific source. Shared entry restrictions come from [Visiting the Libraries](https://www.bu.edu/library/visit-study/visiting-the-libraries/): valid BU IDs allow community access during operating hours; unaffiliated visitors require advance permission. Accompanied guests must check in with identification for all parties. Other visitor categories have their own rules on that page.

The catalog uses BU's Silent designation for `quiet`, Collaborative for `group`, and Power for `outlets`. These describe the space, not current noise, occupancy, reservation availability, or an outlet at every seat. Unknown amenities are omitted, not set to false. Food availability is unverified for these spaces and is omitted throughout. Whiteboards are included only where the individual space page lists them.

Hours are linked to [BU Libraries' current schedule](https://www.bu.edu/library/visit-study/hours/), not copied into the catalog. `checkedAt` is the source-review date, not a live status timestamp. Forecasts and map positions remain building-level even when multiple study spaces share a location ID.

## Sources

- [Mugar PAL Lounge](https://www.bu.edu/library/space/pal-lounge/): third-floor collaborative open seating, power, whiteboard.
- [Mugar Riverview Reading Room](https://www.bu.edu/library/space/mugar-riverview-reading-room-room-115/): first-floor Room 115, silent study, power, whiteboard; unavailable during instruction or staff meetings.
- [Pardee Team Rooms](https://www.bu.edu/library/space/pardee-management-library-team-room/): room identifiers, collaborative designation, power, whiteboard, capacities and BU reservation limits. The entry uses room identifiers rather than inferring floors from room numbers.
- [SEL Lower Level](https://www.bu.edu/library/space/science-engineering-library-lower-level/): silent study; no equipment claims.
- [SEL Group Study Alcove](https://www.bu.edu/library/space/science-engineering-library-group-study-alcove/): collaborative, two-person capacity, two-hour booking limit, no door.
- [Pickering Group Work Room](https://www.bu.edu/library/space/pickering-educational-resources-library/): collaborative, power, whiteboard, eight-person capacity and three-hour daily limit.
- [Stone Science Library Open Seating](https://www.bu.edu/library/space/stone-science-library/): silent open seating during library hours; no equipment claims.

## Location IDs

`mugar`, `pardee`, `sel`, `pickering-library`, and `stone-library` occur in `map-client/public/data/event-impact.json` places, `campus-data.json` locations, and `demo-day.json` locations. The server imports these bundles in `server/src/dashboard/import.ts`. Its public dashboard route uses `locationsFromBundle` in `web/src/data/realData.ts`; all five IDs survive that function's kind filter. This verifies the bundled public-dashboard contract, not a separately deployed database snapshot.

## Finder behavior

The student dashboard links to `/study` from Home, the desktop sidebar, and the mobile Account → More menu. Data goes through `api.getStudySpots` and `api.getStudyHours`; the latter extracts published hours from the deployed `/data/campus-data.json` bundle. Refresh that bundle through the existing data pipeline when its published dates expire. Unknown dates are never carried forward as confirmed hours.

Filters combine with AND and require explicit confirmation. The finder calculates potential study time from the selected starting building, saved walking distances at 1.4 m/s, library hours, published booking limits, and the next imported class with a five-minute arrival buffer. A class in progress prevents a session from fitting. Failed schedule loads, missing routes, or unknown hours never produce a confirmed fit. With no imported classes, the page explains that class conflicts cannot be checked. Room bookings, instructional use, individual seat availability, and previously used daily booking allowances are not available; users must check the linked booking page.

Crowd estimates are building-level model projections for the arrival date/hour, not room occupancy. Missing or outdated forecasts remain unknown. No location, schedule, or filter choices are sent to a third party by the finder.
