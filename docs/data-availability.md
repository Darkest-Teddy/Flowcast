# Data availability

Reviewed October 25, 2026. Published snapshots, live observations, user records, and simulations are different data sources; none should silently substitute for another.

## Connected sources

| Feature | Source and limits |
| --- | --- |
| Buildings, classes, events, posted hours | Saved public BU source records in `map-client/public/data/campus-data.json`. Its `inputFiles` inventory records paths and SHA-256 hashes. A bundle build date is not proof that every upstream source is current. |
| Study spaces | Official BU room descriptions, linked in `web/src/data/studySpots.ts` and `docs/study-spots.md`. Only documented amenities are filterable. Posted library hours do not establish room availability. |
| Accounts, preferences, followed organizers, imported schedules | Authenticated server and PostgreSQL records. Manual `.ics` import is supported. No sample account records are substituted on failure. |
| Transit and bikes | Provider integrations and saved published schedules on the map. Bike availability requires a valid observation no more than two minutes old; failed polls withdraw counts. Playback dock estimates are scenarios anchored to current observations, not historical inventories. Timetables must match their collected service dates and published feed coverage. |
| Weather | Open-Meteo current and hourly model data. Current readings expire after 30 minutes; the hourly request covers yesterday through tomorrow. Playback selects the actual date, and dates outside coverage remain unavailable. |
| Source inventory | The deployed campus bundle's recorded input files and checksums. The inventory does not claim live feed health, retrieval times, or successful refresh jobs. |
| Crowd and event-impact forecasts | Computed simulations using published inputs and behavioral assumptions. Synthetic people, projected occupancy, and estimated attendance remain model outputs, not measured people or confirmed attendance. |

## Weekend hours coverage

The October 26–November 1 scenario now includes all seven dates for the nine branch libraries. The refresh reads both Sunday-starting BU calendar pages; explicit closures and overnight hours retain their meaning. Existing law, medical, Fenway, and FitRec schedules already cover the weekend.

Google Maps regular weekly listings now fill 15 previously missing public venue-days: Warren and Marciano Saturday/Sunday; West Sunday; Saxbys, Buick Street Market, Fuller's Pub, Chequers, and GSU Saturday/Sunday. GSU uses Panda Express's 11 a.m.–7 p.m. meal service only, not the building's hours or all vendors. Existing dated BU hours take precedence, including West's Saturday closing time where Maps differs. The private API overlay still takes precedence for its matching dining dates.

These are explicitly labeled regular-hours fallbacks for October 31–November 1, not verified date-specific holiday schedules. Reviewed place names, addresses, observation times, and exact Maps URLs are saved in `data-pipeline/inputs/google_maps_hours.json`. The public bundle now covers all 175 of 175 venue-days (including explicit closures). Fresh BU Dining pages publish October 31 closures for Breadwinners and Einstein Bros.; the canonical pages had served an older cached week. November 1 uses published weekly Sunday closures from [Zmenu for Breadwinners](https://www.zmenu.com/breadwinners-boston-online-menu/) and [Restaurant Guru for Einstein Bros.](https://restaurantguru.com/Einstein-Bros-Bagels-Boston-3). These are third-party regular-hours fallbacks, not BU-confirmed November 1 schedules. Their listing update dates (January 30, 2024 and June 14, 2026) are retained alongside observation times in `data-pipeline/inputs/published_weekend_hours.json`. Both agree with BU Dining’s dated October 25 closures. Restricted event/team facilities remain restricted; they do not receive invented public opening hours.

The shuttle scenario dates now align with October 26–November 1; the older baseline and recorded source dates remain disclosed. The broader source audit still finds unavailable classroom capacities, unmapped course/event destinations, and unverified Warren Tower C capacity. These remain gaps rather than estimated facts.

## Data or services still missing

| Unavailable capability | What is needed |
| --- | --- |
| Live building occupancy, study-seat counts, room bookings | An authorized occupancy or booking feed from BU or the relevant facility. Published capacities and room descriptions cannot provide current availability. |
| Measured weekly activity or actual student attendance | Consented, authorized observations and a defined measurement method. Synthetic schedules cannot be reported as user activity. |
| Live parking availability | A parking operator occupancy feed. Event-related car demand is a simulation, not a count of arriving cars or remaining spaces. |
| Complete current BU shuttle timetables | A current published timetable. The saved baseline originates in 2024–25; extrapolation must be disclosed and cannot establish current service. |
| Historical weather outside available forecast coverage | A date-matched historical weather integration. Current conditions applied to another date are only a scenario. |
| Calibrated emergency-response outcomes | Observed response measurements and calibration. Incident experiments are scenarios, not operational predictions. |
| Google Calendar synchronization | Calendar OAuth scopes, token management, and sync service. Google sign-in and manual calendar-file import do not imply Google Calendar access. |
| Club registration, officer verification, calendar publishing | Authorized backend records and workflows. Local calendar preview does not publish events. |
| Admin user/application records and shared simulation settings | Authorized administration APIs. Missing records are unavailable rather than empty successful lists. |
| Audience voting, agent usage metrics, source refresh/train jobs | Connected services and actual execution/measurement results. No timers, random tallies, or fabricated success messages substitute for them. |

## Removed runtime examples

The web fixture catalog and sample-chat route were removed, and saved legacy sample replies are excluded when restoring conversation history. Hardcoded landing-page arrivals, bike counts, incident outcomes, and coverage totals were removed or replaced with bundle-derived values. Missing forecast values remain unavailable rather than becoming zero. Tour drawings are explicitly labeled interface illustrations; automated test fixtures remain confined to tests.

If a real source fails or lacks a field, the application should show the limitation. Adding another plausible-looking number is not a replacement for an integration.
