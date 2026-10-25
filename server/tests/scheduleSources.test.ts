// A schedule can be told to Flowcast two ways: imported from an .ics file, or picked from the
// published BU catalog. These tests pin down that neither erases the other.
//
// Needs TEST_DATABASE_URL pointing at a database separate from DATABASE_URL; it skips without one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { database, migrate } from '../src/dashboard/db';
import { importSources } from '../src/dashboard/import';
import { dashboardRouter } from '../src/dashboard/router';
import { DashboardAuthError, type VerifiedUser } from '../src/dashboard/auth';
import { scheduleWindow } from '../src/dashboard/schedule';
import type { CourseSearchResult, ScheduleImportState } from '../../web/src/data/types';

const users = new Map<string, VerifiedUser>();
const verifyUser = async (token: string) => { const user = users.get(token); if (!user) throw new DashboardAuthError(401); return user; };

async function serve(pool: ReturnType<typeof database>) {
  const app = express(); app.use(express.json({ limit: '7mb' })); app.use('/api/dashboard', dashboardRouter(pool, { verifyUser }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }) };
}

test('an .ics import and catalog picks survive each other', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  assert.notEqual(process.env.TEST_DATABASE_URL, process.env.DATABASE_URL);
  const pool = database(process.env.TEST_DATABASE_URL)!;
  let s: Awaited<ReturnType<typeof serve>> | undefined;
  const id = randomUUID();
  try {
    await migrate(pool);
    await importSources(pool);
    s = await serve(pool);
    const token = `sources-${id}`;
    users.set(token, { id, email: 'picker@example.test', name: 'Picker' });
    const call = (path: string, method = 'GET', body?: unknown) =>
      fetch(`${s!.origin}/api/dashboard${path}`, {
        method, headers: { Authorization: `Bearer ${token}`, Origin: s!.origin, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });

    // A real published section, whichever the snapshot happens to list first.
    const found: CourseSearchResult = await (await call('/courses?q=cas')).json();
    const section = found.courses[0].sections[0];
    assert.ok(section.key.includes('|'), 'a section key is "COURSE CODE|SECTION"');

    // One .ics-style item, inside the window so validation accepts it.
    const start = new Date(Date.parse(scheduleWindow().windowStart) + 36 * 3600000);
    const locations: { id: string }[] = (await (await call('/public')).json()).locations;
    const imported = {
      fileName: 'mine.ics',
      items: [{
        id: 'ics-1', title: 'Imported seminar', locationId: locations[0].id,
        start: start.toISOString(), end: new Date(+start + 3600000).toISOString(), source: 'calendar' as const,
      }],
    };

    // Import first, then pick: the import must still be there.
    assert.equal((await call('/schedule', 'PUT', imported)).status, 200);
    const afterPick: ScheduleImportState = await (await call('/schedule/courses', 'PUT', { sections: [section.key] })).json();
    assert.equal(afterPick.items.filter((i) => i.source === 'calendar').length, 1, 'picking classes keeps the imported item');
    assert.ok(afterPick.items.some((i) => i.source === 'course'), 'and adds the picked ones');
    assert.deepEqual(afterPick.courseSections, [section.key]);
    assert.equal(afterPick.fileName, 'mine.ics', 'the import is still named');
    const pickedCount = afterPick.items.filter((i) => i.source === 'course').length;

    // Re-importing replaces only what the last import left.
    const reimported: ScheduleImportState = await (await call('/schedule', 'PUT', {
      fileName: 'mine.ics',
      items: [{ ...imported.items[0], id: 'ics-2', title: 'Replacement seminar' }],
    })).json();
    const calendarItems = reimported.items.filter((i) => i.source === 'calendar');
    assert.equal(calendarItems.length, 1);
    assert.equal(calendarItems[0].title, 'Replacement seminar');
    assert.equal(reimported.items.filter((i) => i.source === 'course').length, pickedCount, 'picked classes survive a re-import');
    assert.deepEqual(reimported.courseSections, [section.key], 'and so does the record of which were picked');

    // Removing the import leaves the picked classes behind.
    const afterDelete: ScheduleImportState = await (await call('/schedule', 'DELETE')).json();
    assert.equal(afterDelete.items.filter((i) => i.source === 'calendar').length, 0, 'the import is gone');
    assert.equal(afterDelete.items.length, pickedCount, 'the picked classes are not');
    assert.equal(afterDelete.fileName, null);
    assert.equal(afterDelete.importedAt, null);
    assert.deepEqual(afterDelete.courseSections, [section.key], 'so the picker can still show them');

    // Clearing the picks too empties the schedule completely.
    const cleared: ScheduleImportState = await (await call('/schedule/courses', 'PUT', { sections: [] })).json();
    assert.deepEqual(cleared.items, []);
    assert.deepEqual(cleared.courseSections, []);

    // An unknown section is refused rather than quietly dropped.
    assert.equal((await call('/schedule/courses', 'PUT', { sections: ['NO SUCH 101|A1'] })).status, 400);
    assert.equal((await call('/schedule/courses', 'PUT', { sections: Array.from({ length: 31 }, (_, i) => `X ${i}|A1`) })).status, 400);
  } finally {
    await s?.close();
    await pool.query('DELETE FROM dashboard_accounts WHERE id=$1', [id]).catch(() => {});
    await pool.end();
  }
});
