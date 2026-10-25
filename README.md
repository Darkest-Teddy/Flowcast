<div align="center">

# Flowcast

**See how crowded BU will be before you get there.**

A live 3D model of Boston University where 36,977 simulated students follow the university's real published class schedules, so anyone can see which dining halls, libraries, gyms and buildings will be packed, hour by hour, and how campus events and emergencies change that.

![Track: Civic Action](https://img.shields.io/badge/Hackachusetts-Civic%20Action-0066cc)
![Built with Kiro](https://img.shields.io/badge/Built%20with-Kiro-7d3fb8)
![Public data only](https://img.shields.io/badge/data-100%25%20public-1d7a35)
![522 tests](https://img.shields.io/badge/tests-522%20passing-1d7a35)
[![CI](https://github.com/Darkest-Teddy/Flowcast/actions/workflows/ci.yml/badge.svg)](https://github.com/Darkest-Teddy/Flowcast/actions/workflows/ci.yml)

![Flowcast: the Charles River Campus at 12:20 PM, buildings glowing by how full they are](docs/images/map-hero.jpg)

</div>

## Why this matters

A campus is a small city of 48,000 people (37,000 students and 11,000 staff) sharing the same sidewalks, dining halls and libraries. Crowding isn't just annoying:

- **Students lose time and calm.** The 12:20 lunch rush, a full library before an exam, a crowded walk between back-to-back classes. For students with anxiety, sensory sensitivities or mobility needs, knowing where it's quiet is the difference between going and staying home.
- **Safety depends on knowing where people are.** During a fire drill or a building closure, where do thousands of students go next? Today nobody can answer that before it happens.
- **Planners fly blind.** Event organizers, dining services and facilities have no shared, open picture of how a schedule change ripples across campus.

The data that could answer these questions is already public, but it's scattered across dozens of BU pages: class schedules, classroom seat counts, dining and library hours, residence-hall capacities, event listings, MBTA timetables. **Flowcast pulls it together, runs a transparent simulation on it, and shows the result in a browser, free, with no login.**

## Highlights

| | |
| --- | --- |
| 🏫 **3 campuses, 101 places** | Charles River, Fenway and Medical, with detailed 3D building models |
| 👥 **36,977 simulated students** | Matching BU's Fall 2025 census by level and full/part-time status |
| 📚 **5,904 real class meetings** | From BU's public Fall 2026 schedule, in 437 classrooms with published seat counts |
| 🎟️ **88 real campus events** | Every public Terrier Central event; 55 at mapped places change crowding on the map |
| 🚇 **Live transit** | MBTA Green Line and buses, BU Shuttle and Bluebikes, live and from published timetables |
| 🚒 **What-if emergencies** | Fire drills, alarms and closures: watch occupants evacuate and choose where to go next |
| 🔍 **Honest by design** | Every number is labelled as published evidence or a model assumption, with its source |
| ♿ **Accessible** | Crowd levels always use a word and a percentage, never colour alone; full keyboard support |

## What you can do with it

### Watch the campus move

Students walk real pedestrian routes between classes, meals, study and the gym. Each building glows by how full it is, and its tag shows a level word and percentage. Scrub the timeline, play at up to 600× speed, or switch to **Clock** mode to follow the real time in Boston.

![Street-level view: Warren Towers, the College of Engineering and walkers on Cummington Mall at 12:22 PM](docs/images/map-street.jpg)

### Plan around campus events

Flowcast collects all of BU's public events and resolves each venue to a mapped building. During an event, students who are free attend it, up to the room's published seat count, and the venue lights up on the map. Events whose location is login-only or unmapped are still listed, with the reason they can't affect the map.

![The map during Thursday-evening events, with the events panel showing simulated attendance](docs/images/map-events.jpg)

The **Event impact** tab answers a simple question: *"If I go to campus on this date, what will be different?"* Pick any date on the calendar to see that day's events and, for every place, hour-by-hour crowding with and without the events.

![Event impact: a calendar date picker, the day's events, and before/after crowding charts](docs/images/event-impact.jpg)

### Rehearse emergencies before they happen

Start a fire drill, alarm or building closure on any building. Occupants evacuate, gather, and then choose a feasible next place. Classes stay where they're scheduled; meals and study move to venues that are open and have room. Unplanned alarms bring a Boston Fire response to the building. Everything is compared against the normal day, so facilities and safety staff can see where the overflow goes.

![The Incidents tab: setting up a scheduled fire drill at Computing & Data Sciences](docs/images/map-incidents.jpg)

### A student dashboard that answers "where should I go?"

Today's schedule, crowd forecasts for your places, nearby events and clubs, and a plain-language **Ask** chat: *"Least crowded library right now"*, *"Quietest dining hall at 6 PM"*, *"How far is CS 132 from DS 340?"* Answers come from the same simulation and walking routes the map uses. Both the dashboard and map Ask tab keep a conversation, so you can follow up with “How far is it from CAS?” or start over with **New chat**.

| Home | Events |
| --- | --- |
| ![Student dashboard home with schedule, forecasts and Ask](docs/images/dashboard-home.jpg) | ![All 88 public BU events, filterable by whether they change the map](docs/images/events.jpg) |

## Who benefits and how it scales

| Who | What Flowcast gives them |
| --- | --- |
| **Students** | Avoid the rush, find a quiet study spot, see how an event changes a building, plan accessible walks |
| **Event organizers and clubs** | See which rooms and times won't collide with peak crowds |
| **Dining, libraries, recreation** | An hour-by-hour picture of expected demand, built only from public schedules |
| **Safety and facilities** | Rehearse drills and closures and see where thousands of people go next |
| **The City of Boston and MBTA** | Student flows onto Comm Ave sidewalks, Green Line stops and Bluebikes docks |

**Beyond BU:** every input is something most universities already publish: course schedules, room capacities, opening hours, event calendars and public transit feeds. The pipeline records where each value came from, so another campus can swap in its own pages. The same approach applies to any public venue with a schedule: hospitals, convention centers, stadium districts.

## Honest by design

A civic tool has to be trustworthy, so Flowcast never passes a guess off as a fact:

- **Published versus modeled.** Class times, seat counts, hours and bed counts are published; enrollment, meals, study and event attendance are named, tunable assumptions. The app labels which is which.
- **Never invented.** No made-up venues, capacities or coordinates. Event registrations are never treated as attendance. Private events are skipped, not parsed.
- **Checked against reality.** We compare the simulation with every real count we could find, including the gaps:

| Real observation | Simulated | Observed | Ratio |
| --- | ---: | ---: | --- |
| FitRec visits, Saturday (hourly, Oct 2026) | 2,500 | 2,510 | 100% |
| FitRec visits, weekday | 1,465 | 3,913 | 37%: staff aren't simulated yet |
| West Campus Dining meals per day | 3,098 | 3,000–5,000 | in range |
| Warren Dining meals per day | 2,722 | 3,850 | 71% |
| Comm Ave at Silber Way, 5–6 PM walkers | 1,547 | 1,818 (2023) | 85% |
| Comm Ave at Granby St, 5–6 PM walkers | 1,572 | 1,995 (2023) | 79% |

The gaps point to the next steps on our roadmap: add BU's 11,140 employees, and fit behavior rates to these counts instead of setting them by hand.

## Built with Kiro

We built Flowcast with Kiro's spec-driven workflow, and the `.kiro/` folder shows how:

| Kiro feature | In this repo |
| --- | --- |
| **Specs** | [`campus-events`](.kiro/specs/campus-events/) and [`student-fatigue`](.kiro/specs/student-fatigue/): EARS requirements → design → tasks, ticked only after tests prove them |
| **Steering** | [`product`](.kiro/steering/product.md), [`tech`](.kiro/steering/tech.md), [`structure`](.kiro/steering/structure.md) and [`fatigue-model`](.kiro/steering/fatigue-model.md): data-honesty and determinism rules that every session follows |
| **Custom agents** | [`flowcast`](.kiro/agents/flowcast.json) (whole project) and [`fatigue-modeler`](.kiro/agents/fatigue-modeler.json) (scoped write access) |
| **Agent hooks** | Start: open tasks and git state · After each write: catch data snapshots changed without a checksum update · Stop: tests and typechecks |
| **Skills** | `/refresh-events`, `/spec`, `/fatigue-calibration` |
| **Property-based testing** | 100 generated event days per run; it caught a real bug where events in classrooms could push a building over capacity |

Read the full story, including what Kiro caught that we would have missed, in **[docs/kiro-features.md](docs/kiro-features.md)**.

## Try it

Requirements: **Node.js 22+** and **Python 3.10+**. No account or API key needed; the map uses free OpenFreeMap tiles.

```bash
git clone https://github.com/Darkest-Teddy/Flowcast.git
cd Flowcast
npm --prefix map-client install
npm --prefix web install
npm --prefix map-client run prepare:data   # builds browser data offline from the committed snapshots
npm --prefix web run dev                   # http://localhost:5174
```

| Open | URL |
| --- | --- |
| Dashboard | http://localhost:5174 (click **Continue with Google**: sign-in is mocked, no account or password) |
| Event impact | http://localhost:5174/event-impact?date=2026-10-29 |
| 3D map | http://localhost:5174/map (first load takes about 20 seconds while the week is simulated) |
| Map during an evening event | http://localhost:5174/map?date=2026-10-29&at=20:15&speed=1 |

**Optional keys** (`map-client/.env.local`, see `.env.example`): `VITE_MAPBOX_TOKEN` for textured Mapbox buildings, `VITE_MBTA_API_KEY` for a higher MBTA rate limit.

**Ask with the agent (optional):** the map's Ask tab and the dashboard's Ask Flowcast send campus questions to the Ask server in `server/`, which holds the OpenAI key. Put `OPENAI_KEY=...` in `server/.env` (gitignored, `chmod 600`), then run it next to the web app in two terminals:

```bash
npm --prefix server install && npm --prefix server start   # http://127.0.0.1:8787
npm --prefix web run dev
```

The web dev server forwards `/api/ask` and `/api/health` to it (set `FLOWCAST_API_URL` for another address). Without the server or a key, both pages answer on the device and say so. Questions about your own schedule are always answered on the device. See [server/README.md](server/README.md).

**Run the tests:**

```bash
(cd data-pipeline && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt && .venv/bin/python -m unittest discover -s tests)
npm --prefix map-client test
```

## How it works

```mermaid
flowchart LR
  A[Public BU pages<br/>schedules, rooms, hours,<br/>housing, events] --> B[Python pipeline<br/>scrape · normalize · provenance]
  T[MBTA · Bluebikes · Boston<br/>open data] --> B
  B --> C[Committed snapshots<br/>with checksums]
  C --> D[TypeScript simulation<br/>36,977 students · 7 days]
  D --> E[3D map<br/>MapLibre/Mapbox + deck.gl]
  D --> F[Dashboard<br/>React]
  D --> G[Ask server<br/>optional]
```

- **`data-pipeline/`**: Python collectors with cached, rate-limited requests and checksummed outputs. They run offline from the saved snapshots.
- **`map-client/src/sim/`**: the simulation. It enrolls students in real sections within seat limits, plans each day around class times, opening hours, capacity and walking time, and adds events and incidents. Results are the same on every run.
- **`map-client/`**: the 3D map: GPU-instanced walkers, crowd glow, and live transit.
- **`web/`**: the dashboard and admin, which also serves the map at `/map`.

## Data sources

All public, with no login: the BU course catalog and classroom directory, BU Dining, BU Libraries, BU Housing, BU FitRec, BU Terrier Central events, the BU Common Data Set and fact sheet, MBTA GTFS and the live API, Bluebikes GBFS and trip history, City of Boston traffic counts, and OpenStreetMap. Every record keeps its source URL and retrieval time; see [`data-pipeline/output/manifest.json`](data-pipeline/output/manifest.json). Character models: [Kenney](https://kenney.nl), CC0.

## Privacy and accessibility

- No personal or login-only data is collected. The simulated students are synthetic and model no real person.
- Personal data in the dashboard (calendar, fatigue score) stays in the owner's session and can be exported or deleted from **Privacy & data**.
- Crowd levels use a 4-step scale (Quiet, Moderate, Busy, Packed) with words, percentages and 4.5:1 contrast. All controls are labelled buttons, the calendar is keyboard-navigable, and the map honors reduced-motion settings.

## Roadmap

1. Add BU's employees and visitors as a separate, clearly labelled layer.
2. Fit behavior rates to the real counts above, and check the fit against counts we held out.
3. Model the semester: midterms, finals, Thanksgiving, and class attendance falling over the term.
4. Show uncertainty as a range across simulated behaviors, not a single number.
5. Map more buildings (3,139 class meetings and 22 events are in unmapped buildings today).

## Team

A team of four, submitted to **Hackachusetts, Civic Action track**.

The full project plan, including roles and design decisions, is in [`.plans/campus-digital-twin-spec.md`](.plans/campus-digital-twin-spec.md).
