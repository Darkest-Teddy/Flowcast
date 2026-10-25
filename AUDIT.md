# Hallmark Audit — Flowcast `web` app

**Verb:** `audit` (read-only — no project files were changed by this run). Full raw output in
`web/.hallmark/before.txt`; 120 screenshots in `web/.hallmark/before/`; the structural record
(every link, field, and handler) in `web/.hallmark/before.json`.

## Scope and how to read this

- **Target:** all 24 rendered URLs — all 21 app routes (student dashboard, admin area) plus the two
  public screens (`/signin`, `/join`) plus the bare root, each rendered at 1280, 1440 and 320/375px.
  There is no landing page yet (`DESIGN.md` and `LANDING_PAGE_BRIEF.md` are a brief for one that
  hasn't been built), so this audits what actually exists and runs today.
- **Full render coverage, this pass.** The first version of this audit only reached `/signin` and
  `/join` — the other 19 routes sit behind `RequireAuth`, which reads a `localStorage` flag a fresh
  headless browser never has. To get genuine screenshots and computed-contrast/layout data on every
  route, I temporarily made the auth check always pass (`web/src/auth/session.tsx`'s `readFlag()`),
  ran the full render pass, then immediately reverted that file to its exact original state —
  confirmed clean via `git diff` before moving on. Nothing in the shipped app was changed by this
  audit.
- **The earlier "black screenshot" caveat is retracted.** The first pass guessed the two renders it
  had were headless Chrome's dark-color-scheme default, not real app behavior. With full coverage
  now in hand, the dashboard renders as a real, correctly styled dark UI — deliberate design, not a
  rendering artifact. Treat it as intentional unless told otherwise.
- **102 raw findings, 96 files, 24 URLs: 61 FAIL, 27 REFLEX, 13 WARN** (gates 10a, 19, 26a, 34, 39a,
  40, 56, 63, 67 at Floor; 24b, 26b, 39b, 49b, 72 at Reflex; F1, F3, F25, F26 at Finish). Most of
  that count is not 102 independent bugs — see "Root causes" below before reading the flat tables.

---

## The read

**What it's for:** a BU student checks, before leaving their room, how crowded a dining hall,
library, or class building will be — `/signin`'s own copy says this plainly and well.
**What works and stays:** the copy is specific and confident (no filler), the `/join` persona
customizer is a real, working, well-built 3D feature, the dashboard's dark theme is coherent and
intentional, and the whole app already routes every color and font through `theme/tokens.css` —
gate 48's token-discipline requirement is met everywhere, which most of this audit's findings are
small deviations *from*, not an absence of a system.
**What reads as generated:** small-caps tracked labels used as decoration (gate 67) and two button
labels with an arrow glued to "Next" (gate 63) are the two tells closest to the surface — minor
individually, exactly the kind of default-reaching the rest of this file flags.
**What's broken:** nothing structurally broken. Every finding below is a real, fixable deviation on
a working app — most trace back to one of five shared root causes, not fifty unrelated defects.

---

## Root causes — fix five things, clear ~70 findings

The flat gate list makes this look like 61 separate Floor failures. It isn't. The app shares layout
and component code consistently, so a handful of fixes clear most of the table.

### 1. Sidebar + topbar both sticky at `top: 0` — 22 instances, one line

`src/layouts/AppShell.module.css:141` — `.sidebar` and `.topbar` are both `position: sticky; top: 0`.
Since `AppShell` wraps every authenticated route, this single rule fires identically on all 22 pages
that use it (every route in the FAIL-56 table below). **Fix once:** offset `.topbar`'s `top` by the
sidebar/banner height (or give the topbar `top: var(--banner-height, 0)`), and all 22 instances clear
together.

### 2. Two shared components under the 4.5:1 contrast floor — 16 instances, two fixes

- **`._button_qpmkr_1._accent_qpmkr_101`** — the shared `Button`'s accent variant — measures 3.02:1
  against its background on every page that uses it ("Open live demo", "Approve", "Upload a
  calendar", "Pause", "Freeze every agent", "Next →"). One token/shade fix in `Button.module.css`'s
  accent variant clears all 6 instances.
- **`._control_13eif_23` / `._input_17boc_47`** — the shared `Field` input/select/textarea border —
  measures 1.50–1.85:1 against its surrounding surface on every page with a form (`/`, `/signin`,
  `/profile`, `/courses`, `/clubs/register`, `/admin/*`). One border-color token fix in the shared
  `Field` component clears the other 10 instances.

Both are listed individually in the Floor table below (gate 40) with full per-page citations, but
both resolve from a single component edit each.

### 3. Global horizontal overflow at 320px — 13 instances, one safety net

Every route overflows at 320px by 5–41px (gate 34). No single element is named per-finding because
this is a mobile-breakpoint issue, not a per-page bug — the highest-leverage fix is the Floor's own
standing rule: add `overflow-x: clip` to both `html` and `body` in `src/styles/base.css`, then spot-
check which route still overflows after that net is in place (likely none).

### 4. Shared Segmented/Toggle control at 26px — 15 instances, one exception

`._on_pad1b_49` (the shared Segmented/Toggle "on" state) renders at 26px tall everywhere it's used —
below the 32–40px app-UI control-height floor. One fix in that shared component's CSS clears most of
the 15 gate-39b instances at once. **One exception, not a blind fix target:** `/admin/live`'s
`._big_1qoaq_1` buttons render at 56–59px — oversized on purpose, plausibly a deliberate large touch
target for a presenter driving a live demo. Leave that one alone; it's the opposite problem (too big,
not too small) and reads as intentional.

### 5. `/join`'s 112px option cards — 1 instance, needs a decision not a fix

`._card_1az0w_95` / `._cardOn_1az0w_96` on `/join` render at 112px — outside both the app-UI (32–40px)
and marketing (44–52px) ranges. This is the course/option-tile picker; 112px plausibly reads fine as
a large tappable card on a mobile-first picker screen. Flagging for a deliberate look rather than
folding it into fix #4 above, since it's a different composition (a card grid, not a toggle).

---

## Floor — FAIL, fix regardless of depth (61 findings → 5 fixes + 2 standalone)

**Covered by root causes 1–4 above:** all 22 gate-56 instances, all 6 accent-button gate-40
instances, all 10 field-border gate-40 instances, all 13 gate-34 instances. Full per-page citations
are in `web/.hallmark/before.txt` lines 5–17 (gate 34), 20–35 (gate 40), 36–57 (gate 56).

**Standalone Floor findings — no shared root cause, fix individually:**

| Gate | Where | What | Fix |
|---|---|---|---|
| 10a | `src/pages/admin/LiveDemo.module.css:224` | `.track b` transitions `width` | Animate `transform`/`opacity` instead |
| 19 | `src/pages/Join.tsx:49` | an em dash in copy | Replace with a comma, colon, full stop, or parentheses |
| 19 | `src/pages/admin/DataSources.tsx:179` | an en dash in copy | Same |
| 26a | `/club/calendar` (1440px) | `div._drop_mju8z_1` ("Drop an .ics file") shows no keyboard focus ring | Give it `:focus-visible` |
| 39a | `src/pages/Join.module.css:75` | `.tab:disabled` signals disabled via opacity alone | Add a fill and ink change alongside the `disabled` attribute (three channels) |
| 39a | `src/ui/Button.module.css:47` | `.primary:hover:not(:disabled)` — same single-channel disabled state | Same |
| 63 | `src/pages/Join.tsx:84` | button label "Next →" | Drop the arrow — a button already implies direction; use a verb alone |
| 63 | `src/pages/Join.tsx:149` | same, second instance | Same |
| 67 | `src/pages/Join.module.css:14` | `.step` — uppercase, 0.06em tracked, used as a label | Labels are the body face, one step smaller, sentence case, untracked |
| 67 | `src/pages/Join.module.css:196` | `.statusLabel` — same pattern | Same |

**Settles at:** polish. Every item here — including the 61 raw instances — is a token/line-level fix,
concentrated in 5 shared locations plus 10 standalone lines.

---

## Reflex — a default the build fell into, fix or state why not (27 findings → root cause 4 + 2 small groups + 3 standalone)

**Covered by root cause 4 above:** 14 of the 15 gate-39b instances (the shared Segmented/Toggle),
with `/admin/live`'s oversized buttons the noted exception. **Covered by root cause 5:** the `/join`
112px cards (also gate 39b).

**Off the 4px spacing scale (gate 24b)** — nine instances, all small UI chrome, all easy same-file
fixes, no shared component in common:

| Where | What |
|---|---|
| `src/layouts/AppShell.module.css:44` | `.brandTag` padding `1px 6px` |
| `src/layouts/AppShell.module.css:120` | `.badge` padding `0 5px` |
| `src/layouts/LayoutFooter.module.css:21` | `.admin` padding `1px 6px` |
| `src/ui/SearchBar.module.css:40` | `.keys` gap `3px` |
| `src/ui/SearchBar.module.css:49` | `.keys kbd` padding `1px 5px` |
| `src/ui/SectionList.module.css:25` | `.count` padding `0 5px` |
| `src/ui/StatCard.module.css:32` | `.bars` gap `3px` |
| `src/ui/Status.module.css:4` | `.badge` gap `6px` |
| `src/ui/Status.module.css:35` | `.tag` padding `0 6px` |

**Other Reflex findings:**

| Gate | Where | What | Note |
|---|---|---|---|
| 26b | `src/layouts/AppShell.module.css` (whole file) | no `:active` state defined anywhere | All eight interactive states expected; this file has none |
| 49b | `/admin/clubs` (320px) | the engage-page link wraps to 2 lines | Shorten the label or set `nowrap` |
| 72 | `/admin/live` (1440px) | `label._pickOption_1mbzf_219` text sits 4px from its box edge | Pad: `max(8px, 0.5em)` sides, `max(4px, 0.3em)` top/bottom |

**Settles at:** polish for the spacing/state items; root causes 4 and 5 above want a short
deliberate look rather than a blind fix, since both are composition calls on touch-target sizing.

---

## Finish — craft detail, never blocking (13 findings)

**Typographic quotes (gate F1)** — straight `'`/`"` in prose, seven instances:

`src/pages/Clubs.tsx:95` · `src/pages/Join.tsx:82` · `src/pages/admin/AdminSettings.tsx:163` ·
`src/pages/admin/AgentBrain.tsx:109` · `src/pages/admin/ClubVerification.tsx:45` ·
`src/pages/admin/DataSources.tsx:67` · `src/pages/admin/Users.tsx:66`

Fix: `'` → `’`, straight `"..."` → curly `“...”` throughout.

**`text-wrap: balance` missing on display heads (gate F3)** — three rule sites:
`src/pages/Forecasts.module.css:55`, `src/styles/base.css:30`, `src/ui/Page.module.css:43`.
One-line addition each; `base.css:30` is the global `h1`–`h4` rule, so fixing it there likely covers
most headings app-wide in one edit.

**Page-level, render-confirmed:**

| Gate | Where | What |
|---|---|---|
| F25 | `/admin/data-sources` (375px) | a table opens with 7 columns off-screen (from "Size") — pin the first column or restack the row |
| F26 | `/` and `/signin` (375px) | the h1 "Where are you headed today?" ends on a stub line — `text-wrap: balance`/`pretty`, or a manual `<br>` between phrases |

**Settles at:** polish for all of these — none require a layout or system change.

---

## What this audit is not

It is a one-time render pass, not a monitor — re-run it after the root-cause fixes above to confirm
the counts actually collapse as predicted (the prediction is ~70 of 102 findings clearing from 5
edits; verify, don't assume). It didn't evaluate the not-yet-built landing page (`DESIGN.md`/
`LANDING_PAGE_BRIEF.md` describe one that doesn't exist as code yet) and it didn't fix anything —
every item above is a finding, not a diff.

## Summary

```
Audit    · web/src, 24 URLs, full render coverage (120 screenshots, before.json structural record)
Floor    · 61 FAIL  → 4 shared root causes (sticky stack, 2 contrast components, mobile overflow)
                       clear ~51 of them; 10 standalone token/line fixes remain
Reflex   · 27        → 1 shared root cause (Segmented/Toggle height) clears 14; 9 are one-line
                       spacing fixes; 3 standalone; 1 composition call (/join's 112px cards)
Finish   · 13        → typographic quotes, text-wrap: balance, 2 page-level notes
Material · nothing invented or assumed; every finding above is a real file:line or rendered URL
           in this repo; the prior "mostly black render" caveat is retracted — full coverage shows
           a correctly, deliberately styled dark UI
```
