import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { assignNames, isFemaleModel } from '../src/sim/names.ts';

const lists = JSON.parse(readFileSync(new URL('../public/data/names.json', import.meta.url), 'utf8'));
const people = Array.from({ length: 36977 }, (_, i) => ({ id: `s${String(i).padStart(5, '0')}`, model: (i * 7) % 12 }));

test('the name lists are 500 female and 500 male names with no overlap', () => {
  assert.equal(lists.female.length, 500);
  assert.equal(lists.male.length, 500);
  const female = new Set(lists.female);
  assert.equal(lists.male.filter((n) => female.has(n)).length, 0);
});

test("everyone's name matches their character's gender", () => {
  const names = assignNames(people, lists);
  const female = new Set(lists.female), male = new Set(lists.male);
  for (const p of people) assert.ok((isFemaleModel(p.model) ? female : male).has(names.get(p.id)), `${p.id} model ${p.model}`);
});

test('within each gender every name is used equally often (±1)', () => {
  const names = assignNames(people, lists);
  for (const list of [lists.female, lists.male]) {
    const counts = new Map(list.map((n) => [n, 0]));
    for (const n of names.values()) if (counts.has(n)) counts.set(n, counts.get(n) + 1);
    const values = [...counts.values()];
    assert.ok(Math.max(...values) - Math.min(...values) <= 1);
  }
});
