# Flowcast Design Kit

This is the design constitution for Flowcast's **marketing site** (the public landing page and any
future marketing pages — NOT the in-app map HUD, which already has its own dark Liquid-Glass
system documented separately and is not touched by this file). Every page built against this brief
follows every rule in this document. Nothing here is a suggestion.

This kit was synthesized — not copied — from close study of four reference screenshots the team
chose specifically because they avoid the generic AI/SaaS look: a Traycer.tech hero (isometric
cafeteria simulation, stacked pill headline), a Traycer closeup (peg-people at a table, shallow
depth of field), the interactive-map-3d.vercel.app 3D map (serif wordmark, monochrome extrusions,
red hotspots), and Kriss.ai (dusty-pink cloud hero, bracket-cornered pill nav, cutaway dollhouse
illustration). None of their literal colors are reused — their *structural moves* are what's
borrowed, rebuilt around Flowcast's own subject matter.

**The named reference this kit actually commits to: a 1950s–60s New England university trail map or
campus walking map** — the kind printed on linen stock, sold in the student union, navy or
forest-ink linework on cream paper, a warm single spot-color used for one thing (the "you are here"
mark, or the campus seal), hand-plotted dashed footpaths between buildings, a small compass rose or
legend tucked in a corner. This is not a vague "map-flavored" mood board — it's one specific,
locatable artifact type, chosen because Flowcast *is*, literally, a campus map, and because nothing
about that reference exists anywhere in the current AI-generated-SaaS-site visual vocabulary. A
first build correctly used warm neutrals and a serif, but genuinely ended up answering a different
brief — a tasteful coffee-brand or stationery-brand site, not a map. Every decision below should be
checkable against the trail-map reference specifically: "would this appear on that object?" If not,
cut it.

---

## 0. Standing process rules (apply to ALL future design decisions, not just this kit)

These rules govern any creative decision this document doesn't already make for you.

**Before writing code for anything new:** present 3 visual directions. For each: a real-world
reference (a specific magazine, poster, or brand — not "modern and clean"), one display font, one
body font, a palette of max 4 colors with one accent, and one signature element. Wait to be told
which direction to build. "Modern and clean" is not a direction; it's the average of the internet.

**Banned by name, no exceptions:** purple-to-blue gradients, Inter or any default system font stack
as the primary typeface, a centered hero with two side-by-side buttons, a 3-card feature grid with
identical cards, emoji used as icons, generic line-icon packs (Lucide/Feather/Heroicons used
undecorated), a soft drop-shadow applied uniformly to every card. Also banned, added after seeing a
first build drift back toward them — these are newer defaults, specific to AI-generated product
sites circa 2025–26, and just as templated as the older ones even though they feel "techy":

- **A colored-dot + "LIVE" pill badge with a stat next to it.** This exact component (rounded pill,
  small colored circle, the word LIVE in caps, a live number) now appears on the majority of
  AI-generated demo product pages regardless of what the product is. If a section needs to say
  "this is live," it has to do it in a way that's specific to a map (see §6) — never this badge,
  in any color.
- **Bracket/viewfinder corner marks** (four small corner-only brackets framing a pill or card, like
  a camera reticle). Also now a default — it was borrowed from one reference without being derived
  from anything Flowcast actually is, which is exactly the failure mode this document exists to
  prevent. Replaced by the contour-ring motif in §6, which *is* derived from the product.
- **Monospace, all-caps, letter-spaced text used as generic "this looks technical" seasoning** —
  on nav labels, section eyebrows, buttons, anywhere that isn't a literal number. §2 restricts
  IBM Plex Mono to actual live data for exactly this reason: the instant it spreads to decorating
  ordinary words, it stops meaning anything and becomes wallpaper.

Section rhythm and density must vary — no two consecutive sections should share the same layout
skeleton.

**After a first draft exists:** review it the way a senior designer hunts for AI tells. List every
element that looks templated, rank the list by how obvious it is, and fix the top 5. Leave anything
that reads as a deliberate choice alone — don't sand off personality in the name of "fixing" it.

---

## 1. Color tokens — max 4, plus neutrals

Every token below is named for what it *is* on the trail-map reference, not what mood it evokes —
that's deliberate, so the palette stays anchored to a real object instead of drifting into generic
"warm startup" territory the way the first build did.

| Token | Hex | Role |
|---|---|---|
| `--fc-ink` | `#1C2B2A` | The printer's ink. A deep, slightly blue-green-leaning near-black — the actual color linework was printed in on a trail map (never a warm brown-black; that's what made the first build read as a stationery brand, not a map). All headlines, linework, contour strokes, and the nav use this, not a separate "brand black." |
| `--fc-linen` | `#EFE7D8` | The paper. A linen/map-stock cream with visible warmth but a slightly cooler, grayer cast than a coffee-shop cream — closer to aged cotton paper than aged coffee. Primary background field. |
| `--fc-waymark` | `#B23A2E` | The one spot color a trail map actually uses — the "you are here" mark, the trail blaze, the campus seal. A brick red closer to true red than terracotta (terracotta reads as ceramics/pottery branding; a waymark red reads as cartography). Used for exactly one thing per screen: the single most important actionable mark — a pin, a primary button, a "you are here" dot. Never a background fill of more than button-size. |
| `--fc-depth` | `#3E6B63` | A muted pine/harbor teal-green — the color water and low elevation are shaded in on a period topographic map, not a modern "tech signal" cyan. Used for anything that represents measured/live data: contour-ring motifs (§6), data readouts, the forecast/crowd visualization itself. This is the one color allowed to feel "technical," because on the reference object it's literally the color of measurement (elevation, depth), not decoration. |

Neutrals (derived from `--fc-ink` tinted toward `--fc-linen`, not a separate gray ramp):

- `--fc-ink-70`, `--fc-ink-45`, `--fc-ink-20` — body copy, secondary copy, hairlines/dividers.
- `--fc-linen-dim` — a deeper linen (`#E3D9C4`) for card fields that sit on the base background
  without needing a shadow to read as separate (see §4).

No pure white, no pure black, no gray pulled straight from a neutral gray scale, and no color in
this file that wouldn't plausibly appear on an actual printed map. That last constraint is the real
test — it's stricter than "no purple gradients," and it's what the first build failed even while
technically avoiding every item on the banned list.

### Map materiality — use at least one of these, don't leave the page feeling like flat color fields

A trail map isn't just four colors — it has texture and marks that pure CSS color tokens can't
convey alone. Bring at least one of the following into the page as an actual rendered surface, not
a metaphor:

- A faint **contour-line texture** (concentric, irregular topographic rings at ~4–6% opacity in
  `--fc-ink`) as a background texture behind hero/section content — never a grid, never dots.
- **Dashed, hand-plotted route lines** (not straight — slightly irregular, like a trail drawn by
  hand) connecting related elements on the page (e.g. linking feature cards, or tracing the path
  described in the hero's camera-dive sequence).
- A small **compass rose or map-legend mark** as a one-off decorative anchor (footer, a section
  corner) — used once, not repeated as a system component.

---

## 2. Type scale — two fonts, named, not "a nice serif"

- **Display: Fraunces** (variable, use the high `opsz`/`SOFT` axis settings for its warmest, most
  characterful cut — not the default static weight). This is a serif with real idiosyncrasy: inky
  ink-traps, a slight ballpoint-pen wonkiness at display sizes. It carries the "collegiate campus"
  association honestly (Flowcast is literally about a university) while being nothing like a
  corporate serif (Georgia, Times, Playfair). Reserve it for H1/H2 and the hero wordmark only.
- **Body/UI: Space Grotesk**. A geometric grotesk with a slightly technical, engineered character in
  its letterforms (note the squared-off curves) — the correct cool counterweight to Fraunces' warmth,
  and it reads as "built," not "templated," the way a product about live data should. Use for body
  copy, nav, buttons, and labels.
- **Data/mono: IBM Plex Mono** — reserved *only* for literal live numbers (crowd %, arrival times,
  "N students on campus right now"). A monospace signals "this is a measurement, not a sentence" at
  a glance, the same instinct that makes a flight tracker or a stock ticker use tabular figures —
  it's the typographic equivalent of the contour-ring signature element in §6: a marker that says
  "the live system produced this," not decoration.

Scale (fluid, `clamp()` between the two bounds):

| Role | Size | Weight/style |
|---|---|---|
| Display XL (hero) | `clamp(3.5rem, 7vw, 6.5rem)` | Fraunces, 600, `opsz` max, slight negative tracking |
| H2 (section) | `clamp(2.25rem, 4vw, 3.5rem)` | Fraunces, 600 |
| H3 (subsection) | `1.5rem` | Space Grotesk, 700 |
| Body large | `1.25rem` | Space Grotesk, 400, line-height 1.5 |
| Body | `1rem` | Space Grotesk, 400, line-height 1.6 |
| Label/eyebrow | `0.8125rem` | Space Grotesk, 600, uppercase, `+0.08em` tracking |
| Data readout | `1–3rem` depending on context | IBM Plex Mono, 600, tabular figures |

---

## 3. Spacing scale

Base unit `4px`. Use only these steps — no arbitrary pixel values in component CSS:

`4, 8, 12, 16, 24, 32, 48, 64, 96, 128, 192` (px)

Section vertical padding is never less than `96px` on desktop, never less than `64px` on mobile.
Deliberately break this rhythm once per page (see §0's "vary density" rule) — one section should
feel compressed and urgent, as a contrast beat, not evenly paced like every other section.

---

## 4. Radius

Two radii only — do not introduce a third:

- `--fc-radius-sm: 10px` — buttons, inputs, small chips/badges.
- `--fc-radius-lg: 28px` — cards, panels, the hero media frame, nav pill. This is deliberately
  larger than a typical "rounded-xl" default — it's what gives the stacked-pill headline treatment
  (§5) and the nav pill their soft, confident, almost-physical-object feel, the way the Traycer and
  Kriss references both lean into aggressively rounded shapes rather than a timid `8px`.

Never mix: a card is either `--fc-radius-lg` all the way, or sharp. No `6px` "almost rounded"
corners anywhere — that reads as an unstyled default that nobody made a decision about.

---

## 5. Components

### Buttons
- **Primary**: `--fc-waymark` fill, `--fc-linen` text, `--fc-radius-sm`, Space Grotesk 600. No
  shadow. On hover, the fill doesn't lighten — it very slightly desaturates toward `--fc-ink`,
  signaling "pressed into the page" rather than "glowing."
- **Secondary**: transparent fill, 1.5px `--fc-ink` border, `--fc-ink` text. Same radius.
- **Pill nav/CTA**: `--fc-radius-lg`-but-fully-rounded (i.e. `9999px`), `--fc-ink` fill, `--fc-linen`
  text — this is the one place a fully-pill shape is allowed; everywhere else uses
  `--fc-radius-sm`/`--fc-radius-lg` rectangles, so the pill nav stays special instead of becoming
  "every button is a pill," which is itself a default to avoid.

### Inputs
- `--fc-linen-dim` fill (not white, not a bordered-only input), `--fc-radius-sm`, 1px `--fc-ink-20`
  border that becomes `--fc-waymark` on focus (no glow/ring — a clean color swap).

### Cards
- `--fc-linen-dim` fill on the `--fc-linen` page background (a field-on-field distinction, no
  shadow needed to separate them — this directly avoids the banned "soft shadow on every card").
  `--fc-radius-lg`. Where a card needs to lift (e.g. the floating "Reimagine."-style card over a
  hero scene, per the Traycer reference), use a single hard-edged offset shape behind it instead of
  a blurred shadow — a flat `--fc-ink` rectangle offset 6px down-right, like a dropped print
  registration mark, not a drop-shadow filter.

## 6. Signature element

**Contour rings.** On a topographic map, concentric irregular rings mean "this is where elevation
(or depth, or density) changes" — and that is *exactly* what Flowcast measures: how crowded a place
is, radiating out from a point. Use thin concentric rings in `--fc-depth`, slightly irregular (not
perfect circles — hand-surveyed, not CAD), radiating from any point that represents a live
measurement: a building on the hero's 3D scene, a stat in the problem strip, a feature-card icon.
The ring spacing can even be literal — tighter rings for a more crowded location, wider for a quiet
one — which makes this a real data encoding, not just a decorative tic. This replaces the bracket-
corner idea entirely: it's derived from what the product actually does, not borrowed from a
reference with no connection to Flowcast's subject matter.

**How to signal "live" without the banned badge**: a small `--fc-depth` coordinate-and-time readout
in the data-mono scale — e.g. `42.3505°N · WED 12:14 PM` — functions the same way a GPS unit or a
surveyor's field mark would, and is unmistakably cartographic. No dot, no pill, no word "LIVE" in
caps as a label unto itself; let the coordinate and the live time do that work.
