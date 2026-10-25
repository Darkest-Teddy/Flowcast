# Study-spot catalog

`web/src/data/studySpots.ts` records 24 study spaces checked against official BU pages on 2026-10-25. Each entry links to its room-specific source. Shared entry restrictions come from [Visiting the Libraries](https://www.bu.edu/library/visit-study/visiting-the-libraries/): valid BU IDs allow community access during operating hours; unaffiliated visitors require advance permission. Accompanied guests must check in with identification for all parties. Other visitor categories have their own rules on that page.

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

`mugar`, `pardee`, `sel`, `pickering-library`, `stone-library`, and `astronomy-library` occur in `map-client/public/data/event-impact.json` places, `campus-data.json` locations, and `demo-day.json` locations. The server imports these bundles in `server/src/dashboard/import.ts`. Its public dashboard route uses `locationsFromBundle` in `web/src/data/realData.ts`; all six IDs survive that function's kind filter. This verifies the bundled public-dashboard contract, not a separately deployed database snapshot.

## Finder behavior

The student dashboard links to `/study` from Home, the desktop sidebar, and the mobile Account → More menu. Data goes through `api.getStudySpots` and `api.getStudyHours`; the latter extracts published hours from the deployed `/data/campus-data.json` bundle. Refresh that bundle through the existing data pipeline when its published dates expire. Unknown dates are never carried forward as confirmed hours.

Filters combine with AND and require explicit confirmation. The finder calculates potential study time from the selected starting building, saved walking distances at 1.4 m/s, library hours, published booking limits, and the next imported class with a five-minute arrival buffer. A class in progress prevents a session from fitting. Failed schedule loads, missing routes, or unknown hours never produce a confirmed fit. With no imported classes, the page explains that class conflicts cannot be checked. Room bookings, instructional use, individual seat availability, and previously used daily booking allowances are not available; users must check the linked booking page.

Crowd estimates are building-level model projections for the arrival date/hour, not room occupancy. Missing or outdated forecasts remain unknown. No location, schedule, or filter choices are sent to a third party by the finder.

## Additional spaces verified on 2026-10-25

- [Mugar 1st Floor Open Study](https://www.bu.edu/library/space/1st-floor-open-study/): Considerate-volume open seating with computers. Verified filter amenities: outlets, whiteboard.
- [Arthur Fiedler Reading Room](https://www.bu.edu/library/space/arthur-fiedler/): Silent reading space; collection materials stay in the library. Verified filter amenities: quiet, outlets.
- [Mugar Basement Open Study](https://www.bu.edu/library/space/mugar-basement-open-study/): Collaborative seating during library hours. Verified filter amenities: group, outlets, whiteboard.
- [Mugar 4th Floor Open Study](https://www.bu.edu/library/space/mugar-4th-floor-study/): Silent seating around the floor perimeter and among the stacks. Verified filter amenities: quiet, outlets, whiteboard.
- [Mugar 5th Floor Open Study](https://www.bu.edu/library/space/mugar-5th-floor-open-study/): Silent seating among the stacks. Verified filter amenities: quiet, outlets, whiteboard.
- [Pardee Open Study Spaces](https://www.bu.edu/library/space/pardee-management-library-open-study-spaces/): Mixed silent and considerate areas with computers. Present your BU ID at entry. Verified filter amenities: outlets, whiteboard.
- [Astronomy Library Open Seating](https://www.bu.edu/library/space/astronomy-library-open-seating/): Unstaffed silent study space; closed on weekends and holidays. Check current hours. Verified filter amenities: quiet.
- [Pickering Quiet Study Room](https://www.bu.edu/library/space/pickering-quiet-study-room/): Reservable for up to three people. Despite its name, BU categorizes this room as collaborative; silent study is not verified. Check booking limits when reserving. Verified filter amenities: group, whiteboard.
- [Mugar Reservable Study Rooms](https://www.bu.edu/library/space/mugar-reservable-study-rooms/): Twelve rooms for one to three people, depending on the room. BU students, faculty and staff may book a combined two hours per 24 hours. Verified filter amenities: outlets, whiteboard.
- [Mugar Music Listening Room](https://www.bu.edu/library/space/mugar-music-listening-room/): Silent study seating alongside turntables and listening stations; headphones listed by BU. Verified filter amenities: quiet, outlets.
- [Mugar Mezzanine Open Study](https://www.bu.edu/library/space/mugar-2nd-floor-mezzanine-open-study/): Considerate-volume seating overlooking the first floor. Verified filter amenities: outlets.
- [Mugar 3rd Floor Open Study](https://www.bu.edu/library/space/mugar-3rd-floor-open-study/): Considerate-volume seating; BU describes study and group work here, rather than a designated collaborative zone. Verified filter amenities: outlets, whiteboard.
- [Mugar 6th Floor Open Study](https://www.bu.edu/library/space/mugar-6th-floor-open-study/): Silent seating overlooking the Charles River; African Studies Library occupies the south side. Verified filter amenities: quiet, outlets, whiteboard.
- [Science & Engineering Library 1st Floor](https://www.bu.edu/library/space/science-engineering-1st-floor-open-study/): Considerate-volume open study seating during library hours. Verified filter amenities: none.
- [Pickering Open Study Space](https://www.bu.edu/library/space/pickering-educational-resources-library-open-study-space/): Considerate-volume open seating during library hours. Verified filter amenities: none.
- [MLK Jr. Reading Room](https://www.bu.edu/library/space/mugar-3rd-floor-mlk-reading-room/): Reading space with a permanent archival exhibit. BU describes silent seating but labels the zone considerate; silent study is not verified. Verified filter amenities: outlets.
- [Mugar 2nd Floor Open Study](https://www.bu.edu/library/space/mugar-2nd-floor-open-study/): Silent seating overlooking the Charles River. Verified filter amenities: quiet, outlets.

The full catalog covers all 24 listings in BU Libraries’ study-space directory. “Considerate” is not mapped to silent or collaborative. Pickering Quiet Study Room is explicitly categorized Collaborative; its name does not enable the silent filter. The MLK Reading Room has conflicting prose and zone metadata, so silent remains unknown. Broad capacity labels such as “4+” are not treated as exact seat counts. Individual reservations and live seat occupancy remain unavailable.
