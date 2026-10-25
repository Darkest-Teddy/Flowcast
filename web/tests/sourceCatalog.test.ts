import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sourcesFromCampusBundle } from '../src/data/sourceCatalog.ts';

test('source inventory comes from deployed provenance without inventing freshness or live health', () => {
  const bundle = JSON.parse(readFileSync(new URL('../../map-client/public/data/campus-data.json', import.meta.url), 'utf8'));
  const sources = sourcesFromCampusBundle(bundle);
  assert.equal(sources.length, bundle.inputFiles.length);
  for (const [i, source] of sources.entries()) {
    assert.equal(source.via, bundle.inputFiles[i].path);
    assert.equal(source.settings[0].value, bundle.inputFiles[i].sha256);
    assert.equal(source.updatedAt, null);
    assert.equal(source.health, 'attention');
    assert.match(source.statusText, /unverified/);
  }
});
test('missing or invalid provenance fails instead of fabricating a source list', () => {
  for (const value of [null, {}, { inputFiles: [{path:'invented.json',sha256:'no'}] }]) {
    assert.throws(() => sourcesFromCampusBundle(value));
  }
});
