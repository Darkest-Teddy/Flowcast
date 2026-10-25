# Flowcast keynote

`flowcast-keynote.html` is a 22-slide, keynote-style product presentation. Open it in any
browser and present full-screen.

| Key | Does |
| --- | --- |
| `→` `space` `↓` `PageDown`, or click the right of the slide | Next |
| `←` `↑` `PageUp`, or click the left third | Back |
| `N` | Show or hide speaker notes |
| `Esc` | Close the notes |
| `Home` / `End` | First / last slide |

The URL carries the slide number (`#14`), so you can link someone straight to a slide or
reload where you left off.

Colour, type and the crowd scale come from `theme/tokens.css` and `theme/crowd.ts`, so the
deck looks like the product. It is deliberately single-theme: a presentation stage is always
dark. The stage is a 16:9 box sized in container-query units, so every slide scales exactly
to whatever projector it lands on.

## The content formula

The deck runs a problem-first arc. Each act answers the question the previous one raises.

| Act | Slides | The question it answers |
| --- | --- | --- |
| Setting | 1–2 | What world are we in? |
| Problem | 3–8 | What is broken, and how do we know? |
| Insight | 9 | Why is it solvable now, and why like this? |
| Solution | 10 | What did we build? |
| Demo | 11–14 | What does it actually do? |
| Proof | 15–17 | Why should you believe it? |
| Reach | 18–19 | Who is it for, and how far does it go? |
| Trust | 20–21 | Is it responsible, and is it real? |
| Close | 22 | What do I remember? |

### How the problem section is built

This is the part worth copying. A problem section fails when it asserts a pain the audience
has to take on faith. This one is built in five moves, and each is sourced:

1. **Scale the world** (slide 2) — 48,000 people, 101 places, one avenue. Establish that
   this is infrastructure, not an inconvenience.
2. **One concrete scene** (slide 3) — 12:20, fifty minutes, the line out the door, the
   granola bar. Second person, specific, no statistics. This is what people remember.
3. **Prove it is measured, not felt** (slide 4) — 1,995 and 1,818 pedestrian crossings an
   hour on Comm Ave, 3,913 FitRec entries, 3,850 meals a day. Every figure is BU's own
   published count, cited on the slide. The audience cannot argue with the university's
   own filings to the City.
4. **Invert the expectation** (slide 5) — the audience is braced for "and there is no
   data". Give them the opposite: 5,904 class meetings, 437 rooms with seat counts, 24
   study spaces, 88 events, 101 places with posted hours. All public, no login.
5. **Name the single missing thing** (slide 6) — the one line from our own source audit:
   *live building occupancy, study-seat counts, room bookings — unavailable.* BU publishes
   the seats; it cannot publish whether anyone is sitting in them.

Then two slides on consequence: everyone solves it by walking there and looking (slide 7),
and the same unanswered question at a far worse moment — a building evacuating (slide 8).

**Why this problem is real.** The claim is not "campus is crowded" — everybody knows that,
and a deck that stops there is solving a non-problem. The claim is narrower and verifiable:
*the data needed to anticipate crowding is already public, already paid for, and already
scattered, so the only way to answer "will there be room?" is to go and find out.* That gap
is documented in `docs/data-availability.md`, which lists exactly which sources exist and
which do not. The problem statement is an audit finding, not a hunch.

**What the section deliberately does not claim.** No invented figure for hours wasted per
student, no invented market size, no claim about what other tools do or do not do. Every
number on a problem slide traces to a published source. A judge who checks one will find it.

### Rules the rest of the deck follows

- **One idea per slide.** The headline is the idea; everything else supports it.
- **Numbers carry a source.** Every figure on a data slide shows where it came from, in
  monospace, on the same line.
- **Volunteer the worst number.** Slide 16 leads with the model's largest miss (FitRec on a
  weekday, 37%) and explains it. Credibility for slide 15 is bought by slide 16.
- **Claims are scoped.** Incidents are scenarios, not operational predictions. Crowd levels
  are projections, not measurements. The deck says so where it matters.
- **Close on the person, not the technology.** The last slide is "Beat the rush."

## Rebuilding this in Canva or Keynote

The slide text is the content; the HTML is one rendering of it. To rebuild elsewhere, keep:

- The arc and the five-move problem section above, in that order.
- The type hierarchy: a monospace eyebrow (`03 · THE PROBLEM IS MEASURED`), a large display
  headline, one supporting paragraph, and nothing else. Headlines are sentences with full
  stops.
- The palette: near-black `#0b0c0e` ground, `#f5f5f7` ink, `#a1a1a6` secondary, `#2997ff`
  accent for emphasis and simulated data, and the crowd scale — `#38bdf8` quiet, `#facc15`
  busy, `#f43f5e` packed — as the only other colours. Measured counts are rose; published
  counts are blue.
- Figures set in tabular numerals so columns line up.

## Checking the facts before you present

Every figure in the deck comes from this repository. If the data is refreshed, re-check:

| Slide | Figures | Source in repo |
| --- | --- | --- |
| 2 | 48,000 people; 101 places | `README.md`, roadmap |
| 4 | 1,995 / 1,818 crossings; 3,913 FitRec; 3,850 meals | `docs/behavior-validation.md`, `docs/calibration-observations.md` |
| 5 | 5,904 classes; 437 rooms; 24 study spaces; 88 events | `README.md`, `docs/study-spots.md` |
| 6 | The unavailable-sources quotation | `docs/data-availability.md` |
| 10 | 36,977 students; crowd thresholds | `README.md`, `theme/crowd.ts` |
| 12 | 88 / 55 / 33 events | `README.md` |
| 15–16 | Observed vs simulated | `README.md` validation table |
| 21 | 522 tests | CI badge in `README.md` |
