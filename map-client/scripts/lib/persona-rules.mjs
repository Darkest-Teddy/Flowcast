// Rule-based student personas, derived locally from the roster's cohorts (no observed
// student-level data exists, and no AI is involved). scripts/calibrate-behavior.mjs writes the
// result to public/data/personas.json.
//
// Personas modulate the day builder's own stable habits (sourceDay.ts HABIT_TRAITS: breakfast,
// gym, library, outing and off-campus-meal regulars, plus the engine's river regulars) rather than
// adding a second per-student trait system: a persona sets how likely its students are to be
// regulars of a habit. Shares are rebalanced per cohort at run time (meanPreserving), so the
// cohort's share of regulars, and every calibrated average, stays where the day puts it.

const assumption = (note) => ({ kind: 'assumption', note });
const share = (slot, value) => ({ target: `habit.${slot}.share`, op: 'set', value });

export const PERSONAS = [
  { id: 'typical', label: 'Typical', description: 'Follows the day’s habits; absorbs the rest of each cohort’s regulars.', effects: [], provenance: assumption('Reference persona.') },
  { id: 'early-riser', label: 'Early riser', description: 'A breakfast regular, everything about 45 minutes earlier, often runs the river path, rarely studies late.',
    effects: [share('breakfast', 0.9), share('river-loop', 0.4), { target: 'activity.*.at', op: 'add', value: -0.75 },
      { target: 'activity.evening-study.probability', op: 'mul', value: 0.6 }],
    provenance: assumption('Chronotype spread among students (morning types are a minority); sizes are assumptions.') },
  { id: 'night-owl', label: 'Night owl', description: 'Rarely eats breakfast, starts about an hour later, an outing regular, studies in the evening.',
    effects: [share('breakfast', 0.1), share('off-campus-outing', 0.85), { target: 'activity.*.at', op: 'add', value: 1 },
      { target: 'activity.evening-study.probability', op: 'mul', value: 1.7 }],
    provenance: assumption('Evening chronotypes are common among undergraduates; sizes are assumptions.') },
  { id: 'library-heavy', label: 'Library regular', description: 'Almost always a library regular; fewer outings and less time on the grass.',
    effects: [share('library', 0.95), share('off-campus-outing', 0.3), share('river-lawn', 0.3)],
    provenance: assumption('A minority of students account for most library hours; sizes are assumptions.') },
  { id: 'gym-regular', label: 'Gym regular', description: 'Almost always a gym regular and often a river-path runner.',
    effects: [share('gym', 0.95), share('river-loop', 0.6)],
    provenance: assumption('FitRec counts entries, so regulars make up much of the measured total; sizes are assumptions.') },
  { id: 'athlete', label: 'Varsity athlete', description: 'Early training every day, a river-path runner, longer meals, few nights out.',
    effects: [share('gym', 1), share('river-loop', 0.8), share('off-campus-outing', 0.25),
      { target: 'activity.workout.at', op: 'set', value: 6.5 }, { target: 'activity.workout.spread', op: 'set', value: 2 },
      { target: 'activity.@dining.minutes', op: 'mul', value: 1.2 }],
    provenance: assumption('BU fields about two dozen varsity teams (a few percent of undergraduates); training times and shares are assumptions.') },
  { id: 'commuter-grad', label: 'Commuting graduate student', description: 'Comes in for class, studies in the evening, few other visits.',
    effects: [{ target: 'activity.*.probability', op: 'mul', value: 0.6 }, { target: 'activity.evening-study.probability', op: 'mul', value: 1.6 }],
    provenance: assumption('Part-time graduate programmes meet largely in the evening; sizes are assumptions.') },
];

/** Shares by cohort (rules). Athletes are concentrated among residents; commuting graduates among part-timers. */
export const COHORT_SHARES = {
  'undergraduate-resident': { typical: 0.41, 'early-riser': 0.12, 'night-owl': 0.18, 'library-heavy': 0.12, 'gym-regular': 0.12, athlete: 0.05 },
  'undergraduate-commuter': { typical: 0.45, 'early-riser': 0.15, 'night-owl': 0.12, 'library-heavy': 0.15, 'gym-regular': 0.1, athlete: 0.03 },
  'graduate-full-time': { typical: 0.4, 'early-riser': 0.15, 'night-owl': 0.1, 'library-heavy': 0.2, 'gym-regular': 0.1, 'commuter-grad': 0.05 },
  'graduate-part-time': { typical: 0.25, 'early-riser': 0.05, 'library-heavy': 0.1, 'commuter-grad': 0.6 },
  other: { typical: 1 },
};

export function derivePersonas(agents, cohortOf, personaFor) {
  const file = {
    schemaVersion: 1,
    description: 'Student archetypes for the behaviour engine, derived locally by scripts/calibrate-behavior.mjs from rule-based shares per roster cohort. Each student gets one persona, stable per student (hash of the id). Personas modulate the day builder’s own stable habits (how likely a student is to be a breakfast, gym, library, outing, off-campus-meal or river regular) plus a few timing shifts; shares are rebalanced per cohort (meanPreserving) so cohort averages stay calibrated.',
    meanPreserving: true,
    personas: PERSONAS,
    cohorts: COHORT_SHARES,
    provenance: { kind: 'assumption', note: 'Rule-based archetypes and shares by cohort; no observed student-level data exists in the repo.' },
  };
  const headcounts = {}, assigned = {};
  for (const agent of agents) {
    const cohort = cohortOf(agent);
    headcounts[cohort] = (headcounts[cohort] ?? 0) + 1;
    const persona = personaFor(agent, file);
    assigned[persona] = (assigned[persona] ?? 0) + 1;
  }
  file.roster = { headcounts, assigned };
  return file;
}
