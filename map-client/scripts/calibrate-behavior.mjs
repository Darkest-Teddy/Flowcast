// Local, offline calibration of the behaviour parameters (no network, no AI service).
//
// Searches the tunable calibration values in public/data/behavior.json (effects with a `tune`
// range) with a seeded random search followed by coordinate descent, simulating representative
// days headlessly on a reduced roster (every Nth student, capacities scaled to match) and scoring
// them with src/sim/validate.ts against measured BU data. A candidate is accepted only if no
// metric's loss rises by more than the tolerance and the weighted total falls. The best candidate
// is then confirmed on the full roster against the current file; only then are values written
// (provenance `fitted`, with scores and search settings), personas re-derived, and
// docs/behavior-validation.md regenerated.
//
//   npm run calibrate                      # defaults: seed 7, every 4th student, 40 evaluations, 10 min cap
//   npm run calibrate -- --seed 3 --step 6 --evaluations 60 --minutes 15 --dry-run
import { writeFileSync } from 'node:fs';
import { behavior as behaviorModule, loadInputs, readData, representativeDays, ROOT, scoreModel, validate } from './lib/behavior-harness.mjs';
import { auditNumbers, writeReport } from './lib/behavior-report.mjs';
import { derivePersonas } from './lib/persona-rules.mjs';

const arg = (name, fallback) => { const index = process.argv.indexOf(`--${name}`); return index > 0 ? Number(process.argv[index + 1]) : fallback; };
const SEED = arg('seed', 7), STEP = arg('step', 4), BUDGET = arg('evaluations', 40), MINUTES = arg('minutes', 10), TOLERANCE = arg('tolerance', 0.02);
const DRY_RUN = process.argv.includes('--dry-run');

function mulberry32(seed) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const random = mulberry32(SEED);
const started = performance.now();
const elapsed = () => (performance.now() - started) / 1000;

const inputs = loadInputs();
const file = readData('behavior');
const personas = derivePersonas(inputs.base.agents, behaviorModule.cohortOf, behaviorModule.personaFor);
const tunables = file.modifiers.flatMap((modifier, m) => modifier.group !== 'calibration' ? [] : modifier.effects.flatMap((effect, e) => effect.tune ? [{ m, e, modifier: modifier.id, target: effect.target, ...effect.tune, start: effect.value }] : []));
console.log(`Calibrating ${tunables.length} parameters (seed ${SEED}, every ${STEP}th student, ≤${BUDGET} evaluations, ≤${MINUTES} min, tolerance ${TOLERANCE})`);

const withValues = (values) => {
  const copy = structuredClone(file);
  tunables.forEach((row, index) => { copy.modifiers[row.m].effects[row.e].value = values[index]; });
  return copy;
};
const sample = validate.sampleRoster(inputs.base, inputs.data, STEP);
const sampleInputs = { ...inputs, base: sample.base, data: sample.data };
const innerDays = representativeDays(inputs.data).filter(day => !day.rain);
let evaluations = 0;
const evaluate = (values) => {
  evaluations++;
  const { scores } = scoreModel(sampleInputs, { behavior: withValues(values), personas, outdoor: inputs.outdoor }, { scale: sample.scale, days: innerDays });
  return scores;
};
const total = (scores) => scores.reduce((sum, score) => sum + score.loss, 0);
const snap = (row, value) => +Math.min(row.max, Math.max(row.min, Math.round((value - row.min) / row.step) * row.step + row.min)).toFixed(6);

let best = tunables.map(row => row.start);
let bestScores = evaluate(best);
const startLoss = total(bestScores);
console.log(`[${elapsed().toFixed(0)}s] start: loss ${startLoss.toFixed(3)} (${sample.base.agents.length.toLocaleString()} students)`);
const tryCandidate = (values, why) => {
  const scores = evaluate(values);
  const verdict = validate.compareScores(bestScores, scores, TOLERANCE);
  const line = `[${elapsed().toFixed(0)}s] #${evaluations} ${why}: loss ${total(scores).toFixed(3)} (best ${total(bestScores).toFixed(3)})`;
  if (verdict.accept) { best = values; bestScores = scores; console.log(`${line}  accepted`); return true; }
  console.log(`${line}  ${verdict.worse.length ? `rejected: ${verdict.worse.slice(0, 2).join('; ')}` : 'no gain'}`);
  return false;
};
const budgetLeft = () => evaluations < BUDGET && elapsed() < MINUTES * 60;

// 1. Random search around the start (a quarter of the budget).
for (let i = 0; i < Math.max(2, Math.floor(BUDGET / 4)) && budgetLeft(); i++) {
  const candidate = best.map((value, index) => random() < 0.5 ? snap(tunables[index], value + (random() < 0.5 ? -1 : 1) * Math.ceil(random() * 2) * tunables[index].step) : value);
  if (candidate.every((value, index) => value === best[index])) continue;
  tryCandidate(candidate, 'random');
}
// 2. Coordinate descent: one step either way per parameter, halving steps when a sweep stalls.
let scale = 1;
while (budgetLeft()) {
  let improved = false;
  const order = tunables.map((_, index) => index);
  for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
  for (const index of order) {
    if (!budgetLeft()) break;
    for (const direction of [1, -1]) {
      const row = tunables[index];
      const value = snap(row, best[index] + direction * row.step * scale);
      if (value === best[index]) continue;
      const candidate = best.slice(); candidate[index] = value;
      if (tryCandidate(candidate, `${row.target} ${direction > 0 ? '+' : '−'}`)) { improved = true; break; }
      if (!budgetLeft()) break;
    }
  }
  if (!improved) { if (scale < 1) break; scale = 0.5; }
}

// 3. Full-roster confirmation against the current file.
console.log(`[${elapsed().toFixed(0)}s] confirming on the full roster…`);
const current = scoreModel(inputs, { behavior: file, personas: readData('personas'), outdoor: inputs.outdoor });
const proposed = scoreModel(inputs, { behavior: withValues(best), personas, outdoor: inputs.outdoor });
const legacy = scoreModel(inputs, undefined);
const changed = best.some((value, index) => value !== tunables[index].start);
const verdict = validate.compareScores(current.scores, proposed.scores, TOLERANCE);
const accepted = changed && verdict.accept;
console.log(`Full roster: loss ${total(current.scores).toFixed(3)} → ${total(proposed.scores).toFixed(3)}: ${accepted ? 'accepted' : `not accepted${verdict.worse.length ? ` (${verdict.worse.join('; ')})` : changed ? ' (no improvement)' : ' (no change found)'}`}`);

const final = accepted ? proposed : current;
const finalFile = accepted ? withValues(best) : structuredClone(file);
const summary = Object.fromEntries(final.scores.flatMap(score => score.metrics.map(metric => [`${score.day} · ${metric.id}`, +metric.value.toFixed(4)])));
const search = {
  method: 'Seeded random search (¼ of the budget) then coordinate descent with step halving; acceptance requires every metric’s loss to rise by at most the tolerance and the weighted total to fall; winner confirmed on the full roster.',
  seed: SEED, step: STEP, sampleStudents: sample.base.agents.length, totalStudents: inputs.base.agents.length, days: innerDays.map(day => day.label),
  evaluations, seconds: elapsed(), tolerance: TOLERANCE, startLoss, bestLoss: total(bestScores),
  parameters: tunables.map((row, index) => ({ modifier: row.modifier, target: row.target, start: row.start, value: best[index] })),
  rejectedBecause: accepted ? undefined : verdict.worse.join('; ') || (changed ? 'no improvement on the full roster' : 'no better values found'),
};
if (accepted) for (const modifier of finalFile.modifiers) {
  if (!tunables.some(row => row.modifier === modifier.id)) continue;
  modifier.provenance = { ...modifier.provenance, kind: 'fitted', validation: { totalLoss: +total(final.scores).toFixed(4) } };
}
finalFile.validation = { generated: new Date().toISOString().slice(0, 10), totalLoss: +total(final.scores).toFixed(4), unconditionedLoss: +total(legacy.scores).toFixed(4), metrics: summary };
finalFile.search = { ...search, accepted };
const wednesday = (run) => run.built.find(row => row.spec.weekday === 2 && row.spec.kind === 'normal').day;
const audits = { legacy: auditNumbers(wednesday(legacy), inputs.base), current: auditNumbers(wednesday(final), inputs.base) };
const timings = final.built.map(row => ({ label: `Conditions engine, ${row.spec.label}`, ms: row.ms }));
if (DRY_RUN) console.log('Dry run: nothing written.');
else {
  writeFileSync(`${ROOT}/public/data/behavior.json`, `${JSON.stringify(finalFile, null, 2)}\n`);
  writeFileSync(`${ROOT}/public/data/personas.json`, `${JSON.stringify(personas, null, 2)}\n`);
  console.log(`Wrote public/data/behavior.json, public/data/personas.json and ${writeReport({ sourceInputs: inputs, legacy: legacy.scores, current: final.scores, audits, timings, search, accepted,
    observed: [['Today’s model', legacy.built], ['Before this calibration', current.built], [accepted ? 'After calibration' : 'Engine (unchanged)', final.built]] })}`);
}
