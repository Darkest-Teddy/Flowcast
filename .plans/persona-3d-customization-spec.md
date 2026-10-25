# Persona 3D Customization — Full Context & Spec

Project: **Flowcast** — a live 3D digital twin of BU's campus, built for BU's DS+X hackathon
(Oct 24–25, 2026). Repo root: `Flowcast/` (map-client = the 3D campus map; web = the student
dashboard/admin platform, which also serves the map at `/map`).

This document is the complete, standalone context for the **persona customization** feature:
students scan a QR code on the live map, build a custom avatar on their phone, and it appears on
the live 3D map, wandering near a chosen campus location. Use this if you're picking the work back
up in a new session, briefing someone else, or need the full rationale for why it's built this way.

---

## 1. What exists already (do not re-explain or re-decide these)

- **map-client** renders ~300 simulated students via a GPU-instanced `ScenegraphLayer` (Kenney Mini
  Character GLBs), split across 3 layers with offset walk-cycle phases so they don't stride in
  lockstep. A known pipeline quirk: Kenney's GLBs carry a `KHR_texture_transform` extension that
  breaks texture sampling unless re-packed by `map-client/scripts/embed_glb_textures.py`.
- **Personas are separate from the simulated population** — they have no class schedule, so each
  one idles at a chosen campus location and deterministically wanders to its nearest neighbor and
  back on a fixed cycle, computed purely from `(persona id, wall-clock time)`. This logic lives in
  `map-client/src/sim/persona.ts` (`wanderStatus`, `personaAgentAt`) and is **correct and final** —
  it was never part of what got rejected below, and should not be rewritten.
- **web** is a React Router + mock-data-layer app (`web/src/data/api.ts`/`fixtures.ts`/`types.ts`;
  pages never touch fixtures directly). It has **zero 3D rendering capability today** — everything
  is CSS/HTML. `/join` is a public, mobile-only route (outside the dashboard shell) reached by
  scanning the QR code shown on the live map (`map-client/src/JoinQr.tsx`).
- Personas sync **same-browser-only** today, via `localStorage` (`web/src/lib/personaStore.ts`).
  `/join` and `/map` share an origin, so this genuinely works in one browser across tabs, but a
  phone scanning the QR has separate storage from the laptop running the big map — true
  cross-device join needs the `/server` that doesn't exist yet. The `api.ts` call shapes are
  already what they'd need to be once it does ("swapping in real endpoints changes nothing on
  screen" is this codebase's own stated philosophy for `api.ts`). **This limitation is accepted,
  not something to solve as part of this feature.**

## 2. What was tried and explicitly rejected (don't repeat this)

A first pass built the avatar as CSS 3D transforms: plain colored cuboid "boxes" for legs/torso,
with a color-swatch picker (skin tone, top color, bottom color as hex swatches) for customization.

**The user rejected this hard**, for two separate reasons — both matter, don't conflate them:

1. **Visual quality**: flat-colored primitive boxes with no silhouette detail "do not represent the
   concept art at all" and read as low-effort, regardless of the fact that CSS 3D transforms are
   technically real 3D space. The fix isn't just "use a different rendering library" — it's that
   each customization option needs an actually distinct, recognizable shape (a hoodie needs a real
   hood; boots need to look taller/bulkier than sneakers; a backpack needs real straps).
2. **Customization model**: color swatches for clothing were the wrong interaction entirely. The
   user wants a **picture-grid picker** (like choosing a costume from a catalog) where each option
   is its own fully-designed, fully-colored choice — not a base garment you recolor.

The user then clarified a further, harder constraint: they want **true 3D rendering and geometry**
— an actual 3D engine rendering real meshes — not a 2D/CSS illustration styled to look dimensional,
even a well-executed one. They were shown reference images and were explicit that those images
describe the *concept* (what categories and options should exist, and the general "Pegman" shape
language), not the rendering technique — they have no 3D reference renders to hand over, and don't
need to; the requirement is for genuine 3D output regardless.

## 3. Reference images (design intent only — described in full since they can't be attached here)

1. **Three small map-marker characters**, each on a flat circular ground-shadow disc with a
   direction-indicator triangle beneath it (like a map agent/pin icon from a slight isometric
   angle): (a) an orange sports-jersey character with a white head wrap, (b) a green-topped
   character with glasses and a cane/walking stick, (c) a plain white sheet-ghost costume with two
   round eye holes. **Intent**: a full "costume" override (like the ghost) should be selectable
   alongside piece-by-piece customization, and every avatar must read clearly as a small marker at
   a distance.
2. **A flat-illustration character turnaround** (front/back/3-4 view) of a hiking persona: long
   dark hair, round tinted sunglasses, a green long-sleeve top, blue shorts, tan high-top hiking
   boots with red laces, a red backpack with a rolled purple sleeping mat strapped on top, holding
   a black trekking pole. Annotated with guide lines labeled "HAIRLINE" and "SHOES." **Intent**:
   hair / eyewear / top / bottom / shoes / backpack / held-item are independently swappable layers
   on one consistent body, and a backpack-with-bedroll is a good bar for "this reads as a real
   object," not just a colored box.
3. **Classic Google-Maps Pegman**: a glossy rounded orange/yellow head on a simple blocky two-tone
   torso (front panel bright yellow/orange, side panel a darker burnt-orange shade, a thin white
   pinstripe down the seam), no separate visible arms/legs — a minimal, instantly-recognizable
   flat-shaded geometric pin-person. **Intent**: this is the shape language for the always-yellow
   base body (genericized — never reproduce Google's actual trademarked asset or branding).
4. **A grid of costume-gallery thumbnail cards** (an explorer with a hat and torch, a banana suit,
   a pilgrim costume, an Android-style robot, a cowboy, a mariachi band member), each a square card
   with one clear illustrated image. **Intent**: this is the *picker UI pattern* — square thumbnail
   cards, one unambiguous image per option, a selection indicator — not specific costumes to copy.

## 4. Approved specification

### 4.1 Flow — a 3-step wizard on `/join` (replaces the old single-scroll form)

```
Step 1 — "Customize your look"
┌───────────────────────┐
│     [live 3D preview] │  continuously, slowly auto-rotating
│      (auto-rotating)  │  true Three.js render of the assembled character
├───────────────────────┤
│ Hair Top Bottom Face →│  horizontally-scrollable category tab bar
├───────────────────────┤
│  [img][img][img]      │  grid of LIVE 3D-rendered thumbnails (not flat icons),
│  [img][img]           │  for the active category only
├───────────────────────┤
│         Next →        │
└───────────────────────┘

Step 2 — "Your details"
  Name, optional short bio, "where do you hang out" location select.
  Nothing else on this screen.

Step 3 — Confirm
  Summary + "Add me to the map" → api.createPersona() → routes to the existing
  status view (own current activity + location — unchanged, still correct).
```

Rationale for splitting into steps rather than one long scroll: a vertical phone screen can't show
a live preview + 7 tabs + grids + name/bio + submit without becoming a cluttered, long scroll,
which directly fights the explicit ask to keep each screen simple.

### 4.2 Categories and options — exact scope, do not add or remove

No skin-tone picker — the base body is **always** Pegman-yellow (glossy, per reference image 3).
No clothing color pickers anywhere — each option below is a complete, pre-colored, distinct design.

| Category | Options (4 or fewer, on purpose) | Shape notes |
|---|---|---|
| **Hair** | Bald, Short, Long, Cap | Short = close dome; Long = dome + flowing flattened back/side panels; Cap = brim + crown |
| **Top** | T-shirt, Hoodie, Jersey, Tank top | Hoodie needs an actual hood shape at the neckline; Jersey gets a V-neck notch + stripe/number detail; Tank is narrower, sleeveless |
| **Bottom** | Shorts, Jeans, Track pants, Skirt | Skirt is a single tapered cone, not two legs; Jeans get a seam-line detail |
| **Face** | None, Glasses, Sunglasses | Real lens + bridge + temple-arm geometry, not a flat rectangle; sunglasses = opaque dark lenses |
| **Shoes** | Sneakers, Hiking boots, Sandals | Boots are visibly taller/bulkier with a sole ridge; sandals show a strap + visible toes |
| **Backpack** | None, Daypack, Hiking pack | Hiking pack has real strap geometry + a cylindrical bedroll on top (reference image 2) |
| **Costume** | None, Ghost, Jersey/sports kit | Full-body override — mutually exclusive with categories above; choosing one dims/disables the other tabs. Ghost = one tapered lathe/sheet shape + two dark eye holes. Never reproduce a real team's branding. |

### 4.3 The non-negotiable technical constraint: true 3D, one geometry source

- Rendering library: **Three.js**, confirmed with the user, newly added to `web/` (which has no 3D
  capability today). `map-client`'s existing deck.gl/luma.gl stack is untouched.
- No external 3D modeling tool or artist is available. "True 3D, don't cut corners" means
  **procedurally-composed low-poly meshes authored in code** — box/cylinder/cone/sphere/lathe
  primitives combined into shapes that are actually recognizable as the named item (the same
  technique real low-poly asset packs use, e.g. the Kenney packs already in this project — just
  hand-built instead of modeled).
- Each part's geometry must be defined **once** as plain, engine-agnostic vertex data (positions /
  normals / indices), then consumed by **both** Three.js (web: the step-1 preview and the live grid
  thumbnails) **and** luma.gl (`map-client/src/layers/personas.ts`'s `SimpleMeshLayer`s) — never
  hand-modeled twice. This repo's existing convention for cross-app sharing (see
  `personaShared.ts`/`persona.ts`'s documented "intentionally duplicated, keep in sync" pattern,
  since `web` and `map-client` don't share a package yet) applies here too.
- Grid thumbnails render the **actual mesh live**, not a static stand-in image — only the active
  tab's ~3–4 options are ever rendering at once, so this is cheap regardless of implementation
  (shared renderer with scissored viewports, or small canvases that pause off-tab).

### 4.4 Performance — still a live map with many simultaneous agents

map-client's persona rendering must keep a **fixed, bounded number of GPU-instanced draw calls
regardless of how many personas are on the map** — never one layer per persona. Group personas by
their *selected variant per category* (e.g. everyone wearing "Hoodie" shares one `SimpleMeshLayer`
instance using that mesh); the layer count is bounded by the small fixed catalog size above
(low dozens at most), independent of how many students join. Keep the existing cheap
walking-bob / idle-sway animation technique (per-instance accessor math only, no skeletal
animation, no extra draw calls per persona).

## 5. Explicitly out of scope / preserved as-is

- Fixing cross-device (phone-to-laptop) live sync — still same-browser-only until `/server` exists.
- Rewriting `wanderStatus` / `personaAgentAt` / `statusText` — these are correct, untouched.
- The QR code itself (`map-client/src/JoinQr.tsx`) and `/join` routing in `web/src/App.tsx`.
- Reproducing Google's actual trademarked Pegman asset/branding, or any real sports team's
  branding — generic shape language and generic colors only.

## 6. Status as of this writeup

A build against this exact spec is in progress (new Three.js dependency in `web/`, the shared
procedural-geometry module, the 3-step picker UI, and the map-client `personas.ts` integration).
Once complete: typecheck clean in both `web` and `map-client`, dev server verified to serve `/join`
and `/map` without console errors. Try it at `http://localhost:5174/join` (run
`cd web && npm run dev -- --host` from the repo root if the server isn't already running).
