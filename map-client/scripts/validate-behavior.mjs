// Validate the behaviour parameters on the full roster: simulate representative days with and
// without the conditions engine, score both against measured BU data, print the scores and write
// docs/behavior-validation.md. Local only (no network). Usage: npm run validate:behavior [-- --no-report]
import { loadInputs, readData, scoreModel } from './lib/behavior-harness.mjs';
import { auditNumbers, writeReport } from './lib/behavior-report.mjs';

const inputs = loadInputs();
const model = { behavior: readData('behavior'), personas: readData('personas'), outdoor: inputs.outdoor };
console.log(`Roster: ${inputs.base.agents.length.toLocaleString()} students`);
const legacy = scoreModel(inputs, undefined);
console.log('Scored today’s unconditioned model');
const current = scoreModel(inputs, model);
console.log('Scored the conditions engine');
for (const score of current.scores) {
  const before = legacy.scores.find(row => row.day === score.day);
  console.log(`\n${score.day}: ${score.metrics.some(metric => metric.weight > 0) ? `calibration loss ${before.loss.toFixed(3)} → ${score.loss.toFixed(3)}` : 'no comparable observations; diagnostics only'}`);
  for (const metric of score.metrics) {
    const old = before.metrics.find(row => row.id === metric.id);
    console.log(`  ${metric.id.padEnd(30)} ${old ? old.value.toFixed(3).padStart(9) : '        —'} → ${metric.value.toFixed(3).padStart(9)}   loss ${old ? old.loss.toFixed(3) : '  —  '} → ${metric.loss.toFixed(3)}${metric.weight === 0 ? ` [${metric.basis}; excluded from calibration]` : ""}`);
  }
}
const wednesday = (run) => run.built.find(row => row.spec.weekday === 2 && row.spec.kind === 'normal').day;
const audits = { legacy: auditNumbers(wednesday(legacy), inputs.base), current: auditNumbers(wednesday(current), inputs.base) };
console.log('\nAudit numbers (Wednesday):');
for (const key of Object.keys(audits.current)) console.log(`  ${key.padEnd(42)} ${String(+audits.legacy[key].toFixed(3)).padStart(9)} → ${+audits.current[key].toFixed(3)}`);
const timings = [...legacy.built.map(row => ({ label: `Today’s model, ${row.spec.label}${row.ms < 5 ? ' (cached weekday)' : ''}`, ms: row.ms })),
  ...current.built.map(row => ({ label: `Conditions engine, ${row.spec.label}`, ms: row.ms }))];
if (!process.argv.includes('--no-report')) console.log(`\nWrote ${writeReport({ sourceInputs: inputs, legacy: legacy.scores, current: current.scores, audits, timings, search: model.behavior.search, accepted: model.behavior.search?.accepted,
  observed: [['Today’s model', legacy.built], ['Conditions engine', current.built]] })}`);
