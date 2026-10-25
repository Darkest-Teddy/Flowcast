import type pg from 'pg';
import { migrate } from './db';
import { importSources } from './import';

/**
 * Brings the dashboard database up to date on start: the tables, then the current public data.
 *
 * Both steps are idempotent and take the same advisory lock, so a restart or a second process
 * never races, and a deploy needs no separate migrate or import step. A failure is logged and
 * leaves the map and Ask running; the dashboard routes report the database as unavailable.
 */
export async function prepareDatabase(pool: pg.Pool) {
  const started = Date.now();
  try {
    await migrate(pool);
    const { hash, unchanged } = await importSources(pool);
    console.log(`dashboard database ready in ${Date.now() - started} ms (data ${hash.slice(0, 12)}${unchanged ? ', already current' : ', imported'})`);
  } catch {
    console.error('dashboard database setup failed: check DATABASE_URL and that the database is reachable (npm run doctor)');
  }
}
