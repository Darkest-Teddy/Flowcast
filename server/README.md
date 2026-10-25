# server (Node.js 22+ + TypeScript)

The Ask server. `POST /api/ask` answers campus questions and short follow-ups (the quick Ask on Home and the map), and `POST /api/chat` holds a longer conversation over every dataset the project ships, with server-built charts and tables (the Ask Flowcast page, `/ask`). Both use an OpenAI agent (`gpt-6-luna` by default, via `@openai/agents`) that reads the same simulation, walking routes, class schedule and opening hours the map plays. The model only picks tools and words the reply; every number comes from a tool. The OpenAI key stays on this server.

It loads the public campus bundle, builds the population, and simulates each weekday of the reference week (2026-10-26 to 2026-11-01) in the background at startup, one day at a time. A day build blocks the event loop for several seconds, so no build starts while an answer is being worked out (it waits up to 30 s); otherwise the prebuild stalled the first answers past the timeout.

The realtime backend in the plan (`.plans/campus-digital-twin-spec.md` Section 8) is not built yet.

## Run

```sh
cd server
npm install
# server/.env (gitignored, chmod 600):  OPENAI_KEY=...
npm start            # or npm run dev to restart on changes
npm run typecheck && npm test   # offline; no key needed
```

With the web app, run `npm --prefix server start` and `npm --prefix web run dev` in two terminals from the repo root. The web and map-client Vite servers (dev and preview) forward only `/api/ask`, `/api/chat` (including `/api/chat/directory`) and `/api/health` here, to `FLOWCAST_API_URL` (default `http://127.0.0.1:8787`); the browser client is `map-client/src/askClient.ts`. When this server is down or has no key, the map and dashboard answer on the device and label the answer. The dashboard never sends questions about the person's own schedule (`web/src/lib/askRouting.ts`).

## Endpoints

- `GET /api/health` → `{ ok, model, keyConfigured, privateBundle, voiceAvailable }`
- `POST /api/ask` with `{ question (1–300 chars), weekday (0 = Monday … 6), time (seconds since midnight), campus ("charles-river" | "medical" | "fenway"), history? }`
  - 200 → `{ answer, model, show: { route, select, points } | null, rows: [{ id, name, percent, level, students, modeled, open, walkMinutes }], calls: [tool names] }`. `show` and `rows` come from the last tool call that changes the map.
  - 400 bad input · 429 rate limit (12/min per client, 600/hour overall) · 503 no key, or the day is still being simulated (`Retry-After`) · 504 model timeout (25 s) · 502 model error.
- `POST /api/chat` with `ChatRequest` from `map-client/src/chatContract.ts`: `{ messages (1–12 turns, oldest first, last from the user; user 1–300 chars, assistant ≤ 2000), weekday, time, campus, date (YYYY-MM-DD or null) }`. Body limit 64 KB.
  - 200 → `ChatResponse`: `answer` (short paragraphs, `**bold**`, `- ` bullets only, ≤ 2000 chars), `visuals` (≤ 4 line/bar/table/stats charts built by the server from this turn's tool outputs, each with `source` provenance and a `note`), `show`, `mapLink` (`/map?at=HH:MM&speed=1`, plus `date=` and `events=0` for another weekday, or `date=` for an event-impact date), `sources` (citations by directory domain), `followUps` (0–3, written by the server from the tools that ran), `model`, `calls`.
  - Earlier turns go to the model as conversation history. Same errors, timeout and the same rate limiter as `/api/ask` (a chat turn counts as a question). The no-key 503 says "not configured"; the warming 503 carries `Retry-After` and `{ retryAfter }`.
  - Same answer checks as `/api/ask`: "prediction" becomes "projection", "accuracy" gives the fallback answer, and numbers no tool returned are counted (earlier turns count as support).
- `GET /api/chat/directory` → `{ domains, chatAvailable, model }`: every domain the chat answers from (crowds, places, classes, walking, events, transit, bikes, housing, population, counts, conditions, calendar, emergencies, parking) with its datasets' provenance, period, public source page (only URLs recorded in the repo, else null), coverage counted from the loaded data, and example questions. Needs no key.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `OPENAI_KEY` or `OPENAI_API_KEY` | none | OpenAI key. Without it Ask, chat, and voice return 503. Never logged. |
| `OPENAI_VOICE_MODEL` | `gpt-live-1` | GPT-Live voice model; the project key must have access. |
| `FLOWCAST_ASK_MODEL` | `gpt-6-luna` | Model name. |
| `FLOWCAST_ASK_PRIVATE_BUNDLE` | unset | `1` uses `data-pipeline/.cache/hackathon/campus-data.json` if it exists. |
| `FLOWCAST_ASK_DAYS_CACHED` | `7` | Built days kept (1–7, LRU). |
| `TRUST_PROXY_HOPS` | `0` | Proxies in front, for per-client rate limits. |
| `HOST` / `PORT` | `127.0.0.1` / `8787` | Listen address. |

## GPT-Live voice

`POST /api/voice/session` accepts only `{ "sdp": "<WebRTC offer>" }` (nonblank, at most
65,536 characters; the existing 128 KiB JSON body limit also applies). It returns HTTP 200
with `{ "id": "<opaque session ID>", "sdp": "<WebRTC answer>" }` and `Cache-Control: no-store`.
The server normalizes OpenAI's `session.id` and `transport.sdp` and does not return other upstream fields.
Errors are sanitized JSON `{ error }`: 400 invalid input, 413 oversized body, 429 rate limit,
503 missing key/voice handler, 504 initialization timeout (25 seconds), or 502 upstream failure.
No upstream bodies, credentials, or SDP are logged. Client disconnects abort initialization.

Use the existing `OPENAI_KEY` or `OPENAI_API_KEY` in `server/.env`; optionally set
`OPENAI_VOICE_MODEL` (default `gpt-live-1`). Restart the server after changing configuration.
`/api/health.voiceAvailable` reports configured key/handler availability, not a verified model entitlement.
The adapter uses fetch with no automatic retries and posts to `https://api.openai.com/v1/live/sessions`:

```json
{
  "session": {
    "model": "gpt-live-1",
    "instructions": "<short Flowcast campus voice and delegation instructions>",
    "delegation": { "type": "client" },
    "store": false
  },
  "transport": { "type": "webrtc", "sdp": "<offer>" }
}
```

The browser owns microphone access, the peer connection, and delegation events. It sends delegated
campus questions through `/api/ask` with the current map context and applies returned UI actions.
The voice prompt delegates campus facts/data/routes, prohibits invented occupancy, labels crowd
information as modeled rather than sensor data, and delegates personal schedule questions too.
The session-creation endpoint does not receive a personal schedule or run backend tools itself.
Each lookup reads the signed-in user's calendar through the authenticated dashboard endpoint and
shares the same bounded two-week context as text Ask. Reads are not cached; account changes end the
call and discard its local history. Signed-out users can still ask campus questions.
Start voice from Home, Ask Flowcast, or the microphone beside the map's weather control. On the map,
the microphone becomes a stop button during a call; errors and blocked playback appear only when needed.
Dashboard controls also provide mute and in-memory captions. Map lookups use its selected campus/day/time;
personal schedule questions use actual Boston dates. Calls close after ten minutes or when leaving the page.
This browser duration limit is a usability guard, not a server-enforced spending limit.
The production host forwards `/api/voice/session` to the API service; frontend development proxies
must also forward that path. Use HTTPS or localhost for browser microphone access.

Voice deliberately has the same public, unauthenticated access policy as Ask. Session creation shares
Ask/chat's per-address limit (12/minute, IPv6 grouped by /64) and global limit (600/hour), including its
bounded client tracking and `TRUST_PROXY_HOPS` setting. These are per-process request limits, **not** a
voice-duration or total-spend cap: media flows directly between the browser and OpenAI after startup.
Multiple server instances each have their own counters. Configure project budgets/usage monitoring
and deployment access controls appropriate for exposing a billable public endpoint; authentication
has not been added here. A public key-configured deployment allows visitors to incur voice charges.

GPT-Live bills voice duration, and delegated Ask model usage is billed separately. WebRTC creation
bills 15 seconds at initialization, credited against duration once running; even abandoned starts can
cost money. Avoid automatic session-creation retries. End sessions with `session.close`, wait for
`session.closed` with a bounded cleanup timeout, and release microphone/peer resources. The HTTP
initialization timeout does not end a successfully established voice session. `store: false` disables
stored-session recording/forking; it is not a claim about every provider retention policy.

References: [OpenAI WebRTC guide](https://developers.openai.com/api/docs/guides/voice-webrtc?api=live),
[GPT-Live conversations](https://developers.openai.com/api/docs/guides/live-conversations), and
[voice usage and cost](https://developers.openai.com/api/docs/guides/voice-latency-cost?api=live).
Tests inject the voice handler or fetch transport and do not create paid sessions.

## Tools

| Tool | Purpose |
| --- | --- |
| `rank_places_by_crowd` | Places ranked by simulated crowding (least or most), in tiers: open, hours unknown, closed, not modeled. |
| `place_day` | One place over a day: published hours, now, an hourly table, quietest and busiest open hours. |
| `place_info` | Published hours, open now and next change, capacity basis and confidence, estimated profiles, evidence. |
| `campus_overview` | Whole-map totals: indoors, walking, not on the map, by campus; busiest places. |
| `list_events` | Published events in the reference week or on one day, in Boston time. |
| `free_rooms` | Rooms in a building with no published class at a time. |
| `model_basis` | Short statements of the model's assumptions by topic. |
| `published_counts` | Observed FitRec hourly entries and Commonwealth Avenue pedestrian counts, labelled as published counts. |
| `walking_route` | Walking distance and time between two places or courses. |
| `find_course` | Where and when a course meets next. |
| `find_places` | Mapped places by kind, campus or name, with hours status. |

`/api/chat` adds these (`src/chatTools.ts`, data loaded by `src/chatData.ts`):

| Tool | Data | Purpose |
| --- | --- | --- |
| `event_impact` | `event-impact.json`, `event-calendar.json` | A date's simulated campus events, the places they change, normal day vs with events for one place; big-venue games and concerts that date. |
| `bluebikes` | `bikes.json` (dock profiles only) | Docks near a place or across BU: docks, typical-day rides docked/undocked, busiest hour, hourly table. Never ride records. |
| `transit_near` | `transit.json`, `transit-schedule.json`, `shuttle-schedule.json` | Scheduled MBTA and BU Shuttle departures from stops within 500 m in the next hour. |
| `housing` | `population.json`, campus bundle | Residences, beds and their basis, resident share, Warren Towers availability; simulated students in one residence. |
| `population_summary` | `population.json` | Published student, employee and FTE aggregates. |
| `model_validation` | `behavior.json` (validation), `calibration-observations.json` | Precomputed simulated-vs-published scores per day type. |
| `what_if_scenarios` | `scenarios.json`, `behavior.json` | Scenario presets and the behaviour assumptions each switches on (effects not precomputed). |
| `weather_effects` | `behavior.json` | Behaviour assumptions for a weather condition and temperature. |
| `emergency_info` | `fire-response.json`, simulation | Incident what-ifs; the modeled BFD first-alarm response to a building and simulated students inside. |
| `academic_calendar` | campus bundle `academicCalendar` | Classes, holidays, recesses, study period and exams for a date. |
| `parking_lots` | `parking.json` | Lots and garages with spaces and their basis. |
| `library_gate_counts` | campus bundle `libraryHistory` | School of Theology Library historical patron counts (2019–20). |

Tools other than the shown day's never wait for a build: an unbuilt day returns `{ available: false, reason, retryAfterSec }` and starts building.

## Never sent to the model

The private bundle (unless `FLOWCAST_ASK_PRIVATE_BUNDLE=1`), stays, trips, agent ids, source assignments and activities, bike ride records (only dock profiles are loaded), anyone's schedule or fatigue score, live MBTA/GBFS data, source URL lists, and the full simulation assumption list. Questions, conversations and answers are not logged and tracing is off.

### Conversation history (`/api/ask`)

`history` is optional and contains at most six complete user/assistant pairs: `{ role: "user" | "assistant", content: string }`. User messages are limited to 300 characters and assistant messages to 4,000; other roles and incomplete pairs are rejected. Each request still supplies the current day, time and campus. The agent uses earlier messages to resolve references and fetches fresh tool facts for each answer.

The browser retains the visible chat while switching tabs and sends only bounded campus conversation context. Personal schedule answers remain on the device. **New chat** cancels the pending request and clears the conversation.

## PostgreSQL dashboard

The dashboard reads public snapshots and authenticated account data only from PostgreSQL. Ask retains its existing
map simulation/data loading behavior. `DATABASE_URL` enables the dashboard pool at server startup;
without it data endpoints return 503 (the public auth config endpoint does not require PostgreSQL). There is no file/fixture fallback and no automatic
migration or import during requests. PostgreSQL 17 is supported.

Put `DATABASE_URL` in `server/.env` (keep this file private and untracked), then from `server/` run:

```sh
npm run db:migrate
npm run db:import
npm start
```

Migrations are idempotent and serialized with a transaction advisory lock. Import reads the full
`map-client/public/data/{event-impact,campus-data,demo-day}.json` sources. An optional directory
can be passed with `npm run db:import -- /absolute/data/directory`. Each snapshot records the
SHA-256 of each input, source timestamps when supplied, file modification times, and import time.
Identical input bytes reuse the existing snapshot. Snapshot insertion and active-pointer change
commit together. Failed imports leave the previous snapshot active. Reimport explicitly after
regenerating source data. Older snapshots remain available for provenance.

Only locations and walking routes are extracted from demo-day; agents/trips are not stored.
All entrance positions are retained. Walking distances use the final saved cumulative distance,
canonicalize the endpoint pair, and choose the shorter saved direction when both exist. Zero-meter
routes remain zero. Public forecasts reuse the dashboard's pure transformations, label model output,
and evaluate published opening hours against the current Boston date, not the source reference week.

### Supabase access

The migration enables row-level security on all four dashboard tables and revokes access from
`PUBLIC`, `anon`, and `authenticated` (when those roles exist). The browser uses the Flowcast API,
not Supabase REST. Configure the backend with a private PostgreSQL connection whose role owns the
tables or bypasses RLS; never expose that connection string to the browser.

### API contracts

All routes are under `/api/dashboard` and return `Cache-Control: no-store`:

- `GET /public`: `{locations, geo, events, impact, hourly, places, clubs}`. Public organizer records
  are unverified; following is false here. Join the personal following IDs from `/me` in the client.
- `GET /me`: `{session, profile, notificationPrefs, following: string[]}`. Creates an authenticated
  account keyed by the verified Supabase UUID on the first personal request. Session roles are `[]`,
  email comes from the verified Auth response, calendar connection is false, officer club is null,
  and onboarded is false. No student, officer, or admin privileges are inferred.
- `PATCH /profile`: partial `Profile`, returns the complete persisted `Profile`. Allowed fields:
  name (trimmed, at most 100 characters), nullable homeLocationId/studySpotId (published dashboard
  catalog IDs), lunchTime/dinnerTime (empty or HH:MM), avatarSwatch (integer 0–5).
- `PATCH /preferences`: partial `{packedRoute, clubEvents, scheduleChanges}` booleans, returns all
  three persisted preferences. These are preferences only; no notification delivery is claimed.
- `PUT /following/:id`: `{following: boolean}`, returns the current user's `string[]` organizer IDs.
  URL-encode the entire organizer ID. Only published organizers are accepted; repeated writes do
  not duplicate IDs.
- `GET /schedule`: `{items, fileName, importedAt, windowStart, windowEnd}`. Before an import or after
  clearing, items is `[]` and all metadata is `null`.
- `POST /schedule/preview`: `{fileName, content}` previews a UTF-8 `.ics` file without saving it.
  Returns `{items, fileName, warnings, windowStart, windowEnd}`. The frontend can select rows and
  remap their `locationId` before saving. Unknown/ambiguous buildings use `locationId: ''`.
- `PUT /schedule`: `{fileName, items}` replaces the account's imported schedule and returns the
  complete schedule state, with server-generated import time and window metadata.
- `DELETE /schedule`: clears items and metadata, returning the empty schedule state.
- `GET /courses`: the published catalog as pickable sections, `{term, total, courses}` where each
  course carries its sections and each section its weekly `slots` (`weekday` with Monday = 0,
  `startSec`/`endSec` from local midnight, `locationId`, `buildingCode`, `roomCode`, `roomCapacity`)
  and the BU page it was read from. `?q=` matches course code and title, returning at most 40 courses
  while `total` counts every matching section. `?keys=a,b` instead returns exactly those sections, so
  the picker can show what an account already saved; keys that no longer match are skipped, not an
  error. Sections BU marks calendar-restricted, and any with no published meeting pattern, are never
  offered.
- `PUT /schedule/courses`: `{sections: [...]}` of at most 30 section keys (`"CAS CS 112|A1"`).
  Expands each into dated meetings across the 120-day window and replaces only the items it owns
  (`source: 'course'`), so an `.ics` import survives. Returns the complete schedule state, with the
  selection echoed in `courseSections` and the save time in `coursesSavedAt`. Dates follow
  `map-client/src/data/academicCalendar.ts`: a meeting runs inside its own `validFrom`/`validTo`, and
  for the prefixes BU's semester calendar covers, only between the term's first and last class day,
  skipping suspended days and running the substituted weekday's timetable on a substitute day.
  Prefixes the calendar excludes (LAW, MED and the other professional schools) keep their published
  weekly pattern. Start and end times are Boston wall-clock, including across the daylight-saving
  change. An unknown section key is a 400 rather than a silent omission.
- `GET /export`: `{exportedAt, account, profile, notificationPrefs, followedOrganizers, createdAt,
  updatedAt, calendars, events, scheduleImport}` from the current persisted account. `events` contains
  imported schedule items, `calendars` contains the import metadata (or `[]`), and `scheduleImport`
  is the same state as `GET /schedule`. No token/hash is exported.
- `DELETE /me`: deletes only the Flowcast profile/preferences/following/imported schedule for the verified UUID and
  returns 204. It does not delete or sign out the Google/Supabase identity. The client must clearly
  describe this scope and sign out afterward. A later authenticated personal request creates a fresh
  Flowcast profile with the same UUID. Public snapshots, guests, and other accounts are untouched.

Mutations require an Origin with the same host (including port) as the request and reject
`Sec-Fetch-Site: cross-site`. The dashboard proxy must preserve Host (`changeOrigin: false`).
Unknown write fields and invalid values return 400, origin failures 403, deleted-session races 409,
and database/unimported-data failures sanitized 503. Writes never report success after a failed query.
The API does not enable cross-origin credential access.

### Imported calendars

Parsing uses pinned [node-ical](https://github.com/jens-maus/node-ical), including its documented
`expandRecurringEvent` API for timezone-aware RRULE, EXDATE and RECURRENCE-ID expansion.
The dependency requires Node 22+, including on hosts whose root package still permits Node 20.
IANA timezones and exact Windows labels from the dependency's bundled mapping are accepted;
Custom timezone labels are accepted only when their embedded VTIMEZONE rules match the supported US Eastern daylight-saving definition; other unknown TZIDs fail explicitly. Floating event
times are interpreted in `America/New_York` with a preview warning. All-day events are skipped
with a warning. Date-only values mislabeled as DATE-TIME and entries without a positive duration are skipped with counts and warnings; no exam duration or venue is inferred. Imported timed events need a positive DTEND/DURATION of at most seven days.

The window starts at today's Boston midnight and ends exclusively at Boston midnight 120 days
later. Only occurrences starting in that window are imported; an event may end after the window.
Daily, weekly, monthly and yearly RRULEs, DURATION, EXDATE, moved exceptions and cancelled exceptions
are supported. Sub-daily frequencies/BYHOUR/BYMINUTE/BYSECOND, RDATE, EXRULE and RANGE exceptions fail
explicitly. Duplicate UID/recurrence identities fail instead of arbitrarily selecting a version.
Location matching uses normalized exact building names/short names and published building codes from the saved campus catalog, including address-prefixed code/room suffixes; ambiguous matches remain unmapped. The original location is retained as `locationText`.

Limits: 1 MiB UTF-8 source, 255-character `.ics` filename, 2,000 source events and output items,
300-character titles, 1,000-character locations, 16 KiB unfolded properties. Preview runs in a
worker with a three-second timeout, 64 MiB old/16 MiB young heap limits, and at most two concurrent
workers (busy requests receive 429). Parser diagnostics are not forwarded because they may contain
calendar text. Schedule-only JSON parsing allows 6 MiB + 4 KiB for worst-case JSON escaping;
the decoded file is still checked against 1 MiB. Existing chat/other route limits are unchanged.
Save accepts unique IDs, source `calendar`, known location IDs or `''`, and valid bounded ISO times;
unknown fields are rejected. Neither raw files nor imported items enter an OpenAI context.

The idempotent migration adds `dashboard_accounts.schedule` (JSONB, default `[]`) and
`schedule_import` (nullable JSONB). Catalog picks need no further migration: the chosen section keys
live inside the existing `schedule_import` document as `courseSections`, and the meetings they expand
to are ordinary `schedule` items with `source: 'course'`. Existing RLS and grants remain intact. Calendar import does
not connect or sync Google Calendar: session `calendarConnected` remains false and
`calendarSyncedAt` remains null. Apply the migration explicitly before deploying these routes.

### Auth configuration and identity

Set `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` (or `SUPABASE_ANON_KEY` as fallback).
`GET /api/dashboard/auth/config` publicly returns only `{url, publishableKey}` before the database
availability gate. Only `sb_publishable_` keys or legacy JWT API keys with role `anon` are allowed;
secret/service-role keys and malformed configuration return sanitized 503. HTTPS is required except
for loopback development URLs. Configuration is never written by the server.

`GET /public` and `GET /auth/config` require no bearer. Every personal route requires
`Authorization: Bearer <Supabase access token>`. The browser owns PKCE, session refresh, and signout.
The server calls `GET <SUPABASE_URL>/auth/v1/user` with `apikey` and `Authorization` on every personal
request, using a five-second timeout and refusing redirects. It never decodes a user JWT to establish
identity, reads identity from a cookie/body, or grants roles from metadata. Missing/malformed tokens
and Auth 401/403 responses return 401. Auth network/timeouts, malformed responses, other upstream
errors, or unavailable configuration return 503. The existing same-origin mutation check still runs
first and returns 403 on an origin violation.

`dashboard_accounts.id` is the verified Supabase UUID. An insert-on-conflict preserves existing
profile, preferences, and follows across devices and token refreshes. Initial display name comes
only from Auth `user_metadata.full_name` or `user_metadata.name`, trimmed to 100 characters; it is
editable display text, never authorization. Email comes only from the Auth response's top-level
`email`. Auth tokens are neither stored nor exported. The legacy `dashboard_guests` table/data are
preserved without migration into accounts; its cookies no longer identify any personal request.

`src/dashboard/db.ts` is the idempotent local/Supabase migration source. It creates the separate
account table and enables RLS with no browser policies, revoking PUBLIC/anon/authenticated access.
Run migrations explicitly with an owning backend PostgreSQL role; requests never migrate remotely.
The verifier and config getter are injectable through `dashboardRouter(pool, options)`; the default
verifier's HTTP transport is injectable through `createUserVerifier(config, request)`.

Reference: [Supabase JWT verification](https://supabase.com/docs/guides/auth/jwts) documents the
Auth user endpoint and headers; [API key guidance](https://supabase.com/docs/guides/getting-started/api-keys)
distinguishes public publishable/anon keys from privileged secret/service-role keys.

### Verification

```sh
npm run typecheck
npm test
npm run test:db
```

`test:db` loads `server/.env` and requires `TEST_DATABASE_URL` pointing at a dedicated database,
separate from `DATABASE_URL`; without it the integration test explicitly skips. Tests apply migrations
and import actual source data into that database, exercise authenticated HTTP accounts and mutations, restart the
router to verify persistence, check isolation/export/deletion, and verify sanitized database failures.
Test-created accounts and the legacy guest preservation fixture are cleaned up; imported public snapshots remain. `npm test` does not load `.env`
and keeps the existing Ask tests runnable without PostgreSQL.

Auth unit tests inject HTTP responses and cover forged tokens, network failures, malformed user data,
privileged config rejection, and the database-independent config route. Database tests use injected
verified users to exercise persistence and cross-device identity; they do not claim a real Google login.
