import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import type pg from 'pg';
import { z } from 'zod';
import type { CampusData } from '../../../map-client/src/data/campusData';
import type { CampusGeo } from '../../../web/src/data/types';
import type { EventBundle } from '../../../web/src/data/realData';
import { CLASSROOM_SUFFIX } from '../../../map-client/src/sim/residenceSplit';

export interface Snapshot { impact: EventBundle; campus: CampusData; geo: CampusGeo }
const point = z.tuple([z.number().finite(), z.number().finite()]);
const demoSchema = z.object({
  locations: z.array(z.object({ id: z.string(), position: point })),
  walkRoutes: z.record(z.string(), z.object({ path: z.array(point), cumulative: z.array(z.number().finite().nonnegative()).min(1) })),
});
const impactSchema = z.object({ schemaVersion: z.literal(1), places: z.array(z.object({ id: z.string() }).passthrough()).min(1), events: z.array(z.object({ id: z.string() }).passthrough()), baseline: z.record(z.string(), z.unknown()), dates: z.record(z.string(), z.unknown()) }).passthrough();
export const defaultDataDir = fileURLToPath(new URL('../../../map-client/public/data/', import.meta.url));

export async function importSources(pool: pg.Pool, directory = defaultDataDir) {
  const sources = await Promise.all(['event-impact.json', 'campus-data.json', 'demo-day.json'].map(async (name) => {
    const path = resolve(directory, name);
    const [bytes, info] = await Promise.all([readFile(path), stat(path)]);
    const data = JSON.parse(bytes.toString('utf8'));
    return { name, data, sha256: createHash('sha256').update(bytes).digest('hex'), modifiedAt: info.mtime.toISOString(), sourceTimestamp: data.collectedAt ?? data.builtFor ?? null };
  }));
  const impact = impactSchema.parse(sources[0].data) as unknown as EventBundle;
  const campus = z.object({ locations: z.record(z.string(), z.unknown()), referenceWeekStart: z.string() }).passthrough().parse(sources[1].data) as unknown as CampusData;
  const demo = demoSchema.parse(sources[2].data);
  const geo: CampusGeo = { positions: Object.fromEntries(demo.locations.map((l) => [l.id, l.position])), walkMeters: {} };
  for (const [key, route] of Object.entries(demo.walkRoutes)) {
    if (route.path.length !== route.cumulative.length) throw new Error('Invalid saved route');
    const canonical = key.split('>').sort().join('>');
    const meters = route.cumulative.at(-1)!;
    // The dashboard represents undirected distances; choose the shorter saved direction.
    geo.walkMeters[canonical] = Math.min(geo.walkMeters[canonical] ?? Infinity, meters);
  }
  // A residence's classrooms (sim/residenceSplit.ts) share its building: same entrance, same walks.
  for (const place of impact.places) {
    if (!place.id.endsWith(CLASSROOM_SUFFIX)) continue;
    const residence = place.id.slice(0, -CLASSROOM_SUFFIX.length);
    if (geo.positions[residence]) geo.positions[place.id] = geo.positions[residence];
    for (const [key, meters] of Object.entries(geo.walkMeters)) {
      const ends = key.split('>');
      if (!ends.includes(residence)) continue;
      const aliased = ends.map((end) => (end === residence ? place.id : end)).sort().join('>');
      geo.walkMeters[aliased] = Math.min(geo.walkMeters[aliased] ?? Infinity, meters);
    }
    geo.walkMeters[[residence, place.id].sort().join('>')] = 0;
  }
  const provenance = sources.map(({ data: _data, ...source }) => source);
  const hash = createHash('sha256').update(sources.map((s) => `${s.name}:${s.sha256}`).join('\n')).digest('hex');
  const result = { hash, locations: demo.locations.length, routes: Object.keys(geo.walkMeters).length };
  // Already the current snapshot (the usual case on a restart): skip resending the payload.
  const current = await pool.query('SELECT 1 FROM dashboard_current WHERE snapshot_hash=$1', [hash]);
  if (current.rowCount) return { ...result, unchanged: true };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(78219461)');
    await client.query('INSERT INTO dashboard_snapshots(hash,sources,payload) VALUES($1,$2,$3) ON CONFLICT(hash) DO NOTHING', [hash, JSON.stringify(provenance), JSON.stringify({ impact, campus, geo })]);
    await client.query('INSERT INTO dashboard_current(singleton,snapshot_hash) VALUES(true,$1) ON CONFLICT(singleton) DO UPDATE SET snapshot_hash=excluded.snapshot_hash', [hash]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
  return { ...result, unchanged: false };
}
