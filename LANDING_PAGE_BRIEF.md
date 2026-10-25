# Flowcast Landing Page — Full Creative Brief

**Read `DESIGN.md` first and follow it exactly — colors, type, spacing, radius, and components are
already decided there. This document is the content, structure, motion, and concept brief for one
page: the public marketing landing page at the root of the `web` app.**

**Work this brief as a senior product designer with brutal taste, building a landing page for a
revolutionary company — not a template-filling assistant.** That means: no safe defaults chosen
because they're easy, no section included because pages like this usually have one, and no polish
skipped because the deadline is close. If something here is weak, say so and propose something
stronger before building it — don't silently ship the mediocre version.

Before touching code: load the `frontend-design` skill, and write all copy on this page in clear,
direct, concrete language — short sentences, no filler adjectives, no "revolutionize" / "seamless" /
"leverage." Say exactly what the product does and why it matters, the way an engineer would explain
it to a friend, not the way a pitch deck would.

Then follow `DESIGN.md` §0's standing process: if any decision below is genuinely open (not already
pinned by this brief), present 3 directions and wait for a pick before building it. Don't skip the
post-draft "hunt its own AI tells" review — do it, rank the findings, fix the top 5, before calling
this done.

**The hook/tagline is its own deliverable, not a byproduct of writing the hero.** Before building
the hero section, write 5–8 candidate taglines for Flowcast as a standalone exercise — short,
concrete, specific to what the product actually does (per §1's problem statement), none of them
generic enough to belong to any campus app. Pick the strongest one, say why it won it over the
others, and only then build the hero around it.

---

## 1. The problem this page has to make a stranger feel in 10 seconds

Boston University is a big, crowded campus and nobody has a reliable way to see it coming. Dining
halls hit a wall of a line at 12:15 and nobody knew it was coming until they were standing in it.
FitRec is either empty or completely slammed and there's no way to tell which from your dorm room.
Meanwhile there's a constant undercurrent of students who *want* to explore campus — find an event,
find a quiet study spot, find out what's actually happening tonight — but won't spend an hour
wandering to find out, so they default to the three places they already know and never discover
anything else.

**Flowcast's answer**: a live, interactive 3D map of campus that shows what's happening *right now*
— crowding, transit, events, class traffic — so a student can make one good decision (where to eat,
where to study, what to go to) instead of guessing or wasting time finding out the hard way. It's
not a static campus map. It's the campus, live, with real students moving through it in real time.

This paragraph — in the team's own words, not a marketing rewrite of it — is the thing every section
of this page has to keep proving. If a section doesn't advance this argument, cut it.

---

## 2. Reference sweep — what to actually go look at before designing anything

Visit and screenshot-study each of these for the *specific thing* named, not generally:

- **[trayitforward.tech](https://trayitforward.tech/)** — the whole reason this brief exists. Study:
  the stacked two-tone pill headline treatment ("Intelligence in" / "every kitchen."), the isometric
  low-poly simulation scene with colored peg-people performing real activity in it, the floating
  rounded card with a micro-headline + one sentence + pagination dots, the shallow-depth-of-field
  "peg person at a real table" shot that makes a simulated character feel like it's in a real place.
- **[flighty.com](https://flighty.com/)** — study how a data-heavy, real-time product (flight
  tracking) makes live numbers feel calm and premium instead of dashboard-y; the restraint in how
  often a live stat appears.
- **[granola.ai](https://www.granola.ai/)** — study the quiet, confident use of negative space and
  how product screenshots are framed (angle, shadow treatment, what's cropped out) without ever
  using a plain rectangular screenshot in a browser-chrome frame.
- **[kriss.ai](https://kriss.ai/)** — study the floating depth-blurred 3D clouds (directly relevant
  to §3's hero) and the scroll/click hotspot pattern on its cutaway-building illustration. Do **not**
  reuse its bracket-cornered nav/button treatment — `DESIGN.md` §0 explicitly retired that as a
  now-generic AI-site default; the contour-ring motif in `DESIGN.md` §6 is Flowcast's own signature
  element, derived from what the product measures rather than borrowed from a reference.
- **[interactive-map-3d.vercel.app](https://interactive-map-3d.vercel.app/)** — study the serif
  wordmark treatment, the monochrome-extrusion map with color reserved only for hotspot markers, and
  the "tap and drag to explore" affordance card centered over the 3D view.

None of these get copied. Each contributes one structural idea, rebuilt in Flowcast's own palette
and type per `DESIGN.md`.

---

## 3. The hero — a GTA V character-switch transition, built for the web

This is the single most important section on the page. Research "GTA V character switch transition"
before building it if it isn't already familiar: when the player switches between protagonists, the
camera doesn't cut — it rockets straight up and out of the current scene, punches through a cloud
layer into a brief top-down satellite view that establishes the whole map's scale, then dives back
down through clouds into the new character's exact location, landing at street level. It's used to
hide a loading transition, but the effect it produces is "establish the scale of the whole world,
then commit to one real place in it" — which is exactly Flowcast's pitch (campus-wide awareness,
down to one building).

**Build this sequence, scroll- or load-triggered (your call which, per the process rule in §0 if
genuinely undecided):**

1. **Opening state**: the viewport is filled with soft, depth-blurred 3D cloud forms (per the
   Kriss.ai reference) in `--fc-linen` tones, lit warm. The Flowcast wordmark (Fraunces, Display
   XL) sits centered, quiet, no other chrome.
2. **The dive**: clouds part / scale past the camera with motion blur, exactly like breaking through
   cloud cover. This reveals a brief top-down, monochrome, extruded view of BU's campus footprint
   (same structural idea as the interactive-map-3d.vercel.app reference) — just long enough to read
   as "this is the whole campus."
3. **The commit**: the camera continues diving into one point on that top-down view, which seamlessly
   resolves into the **actual live product** — the real 3D map engine Flowcast already has
   (map-client's deck.gl/Mapbox renderer), at a cinematic low angle, with real buildings and real
   customizable yellow personas (see §4) already walking around in it. This is not a video or a
   screenshot standing in for the product — embed or capture the real thing.
4. **The landing**: once settled on the live 3D view, show a clear, literal prompt overlaid on it —
   something like "Click to explore the live campus" — inviting a click directly on the 3D scene
   itself to be taken into the full map application. The 3D view is both the payoff of the animation
   and a working portal into the product, not decoration. If this moment needs to additionally
   signal "and it's live right now," use `DESIGN.md` §6's coordinate/time readout treatment
   (e.g. `42.3505°N · WED 12:14 PM`) — never a colored-dot "LIVE" badge; that pattern is explicitly
   banned in `DESIGN.md` §0.
5. **The scroll cue**: at the very bottom of this hero viewport, a small, quiet indicator (not a
   generic bouncing chevron) invites the visitor to continue — e.g. a single faint contour ring
   (per `DESIGN.md` §6) pulsing outward once behind a "Scroll to see how it works" label, echoing
   the same "measurement radiating from a point" idea the rest of the page uses, rather than an
   unrelated decorative animation.

**Motion density note**: this hero is where the page's 3D-helix motif (see §5) should be at its
densest and most deliberately "look expensively technical" — tangled, spiraling 3D line/ribbon forms
threading through the cloud-to-map transition, suggesting flight paths, data traces, transit lines
converging on campus. The rest of the page uses the helix motif far more sparingly (an accent per
section, not a constant background), so the hero reads as the "impressive, technical" overture and
the rest of the page can breathe.

---

## 4. Yellow personas, walking and interacting — use the real thing

Flowcast's product already has a real, working feature for exactly this: customizable
Pegman-yellow 3D personas that walk and idle on the live campus map (`map-client/src/layers/
personas.ts`, `map-client/src/sim/personaParts.ts` — real procedural 3D geometry, not flat icons).

**Do not invent new illustrated characters for this page.** Wherever this brief calls for "people
shown as yellow men... walking and interacting," that means: render the actual persona system,
placed into campus scenes on this page, the same way Traycer shows its peg-people actually sitting
at actual cafeteria tables doing an actual activity (image 15's shallow-depth-of-field shot is the
bar to hit — a real character, in a real place, doing something specific, not a generic crowd).
Show them: waiting in a dining hall line, walking into FitRec, sitting on a quad bench during an
event. Each of these should map to a real location/scenario the product already models.

---

## 5. The rest of the page — Traycer-inspired structure, bento features, scroll-zoom storytelling

After the hero, the page shifts from "establish the scale and the wow" to "prove the specific
value," using the density-and-rhythm variation `DESIGN.md` §0 requires — don't repeat the hero's
visual intensity section after section.

- **Problem strip**: a short, honest restatement of §1's problem, in the first person plural the
  team actually used ("We were standing in a 20-minute line..."), paired with one real, specific
  live stat from the product (e.g. a crowd percentage, in IBM Plex Mono per `DESIGN.md` §2) — not an
  illustration, an actual number.
- **Scroll-triggered 3D zoom feature sections**: as the visitor scrolls, the camera on an embedded
  3D campus model auto-zooms into a different real location per section to introduce each feature —
  zoom into Warren Dining while explaining crowd forecasting, zoom into a Green Line stop while
  explaining live transit, zoom into a lecture hall while explaining class-driven crowd prediction.
  This is the kriss.ai "scroll or click hotspots" pattern, applied to Flowcast's real 3D map instead
  of an illustrated dollhouse. Thread the helix motif through these transitions as the connective
  tissue between zoom targets (a spiraling line that traces the camera's path from one location to
  the next), not as a static background.
- **Bento-box feature grid**: once the individual zoom-ins have made their point, summarize the full
  feature set in an asymmetric bento grid (mixed cell sizes — one large hero cell, several smaller
  ones — explicitly not the banned uniform 3-card grid from `DESIGN.md` §0). Candidate cells: live
  crowd forecasting, transit + traffic, course-aware scheduling, customizable personas, QR
  phone-join, campus-wide coverage (3 campuses). **Each cell is an animated render promotion card,
  not a static screenshot**: a short looping clip or scroll-driven animation of the real 3D product
  doing the specific thing the cell describes (the crowd meter ticking up in real time, a persona
  walking into frame, the QR flow resolving into a live avatar) — motion is what sells the "live"
  claim; a frozen screenshot undercuts it. Never a generic icon standing in for the feature.
- **"Build a better community" close**: the page's emotional thesis — this isn't just a utility,
  it's meant to help students actually discover and show up to the campus around them instead of
  defaulting to the same three places. End here, not on a generic "Get started" band.
- **Footer**: minimal, matches `DESIGN.md` component rules — no fourth color introduced here.

---

## 6. What "done" requires before shipping this page

- Every rule in `DESIGN.md` followed, including the ones that are easy to forget under deadline
  pressure (two radii only, no shadow-on-every-card, the derived warm-neutral ramp).
- The post-draft "hunt its own AI tells" review from `DESIGN.md` §0 actually performed and written
  down (which 5 things were found, ranked, and fixed) — not skipped because the deadline is close.
- The hero's 3D view is the real product rendering, not a stand-in asset.
- Every persona shown anywhere on the page is the real customizable persona system, in a specific
  named location doing a specific named thing.
- Copy reviewed against §1's problem statement: cut anything that doesn't advance that argument.
