import pg from 'pg';
import { ORG_TABLES, ORG_TABLE_NAMES } from './orgs';
import { CLUB_TOOL_TABLES, CLUB_TOOL_TABLE_NAMES } from './clubTools';

export function database(url = process.env.DATABASE_URL): pg.Pool | undefined {
  if (!url) return undefined;
  // A day build blocks the event loop for several seconds (campus.ts); a short connect timeout then
  // fires as soon as the loop frees, failing requests whose connection was fine.
  const pool = new pg.Pool({ connectionString: url, max: 10, connectionTimeoutMillis: 20000, statement_timeout: 10000 });
  pool.on('error', () => console.error('dashboard database connection failed'));
  return pool;
}

export async function migrate(pool: pg.Pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(78219461)');
    await client.query(`
      CREATE TABLE IF NOT EXISTS dashboard_snapshots (
        hash text PRIMARY KEY, sources jsonb NOT NULL, payload jsonb NOT NULL,
        imported_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS dashboard_current (
        singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
        snapshot_hash text NOT NULL REFERENCES dashboard_snapshots(hash)
      );
      CREATE TABLE IF NOT EXISTS dashboard_accounts (
        id uuid PRIMARY KEY, profile jsonb NOT NULL, preferences jsonb NOT NULL,
        following text[] NOT NULL DEFAULT '{}',
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS dashboard_guests (
        id uuid PRIMARY KEY, token_hash text UNIQUE NOT NULL,
        profile jsonb NOT NULL, preferences jsonb NOT NULL,
        following text[] NOT NULL DEFAULT '{}',
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
        expires_at timestamptz NOT NULL DEFAULT now() + interval '30 days'
      );
      -- "Was it busy?" reports: anonymous counts only. No account, session or timestamp column.
      CREATE TABLE IF NOT EXISTS dashboard_crowd_reports (
        location_id text NOT NULL, day date NOT NULL,
        hour smallint NOT NULL CHECK (hour BETWEEN 0 AND 23),
        answer text NOT NULL CHECK (answer IN ('quiet','ok','packed')),
        count integer NOT NULL CHECK (count > 0),
        PRIMARY KEY (location_id, day, hour, answer)
      );
    `);
    await client.query(ORG_TABLES);
    await client.query(CLUB_TOOL_TABLES);
    await client.query(`
      ALTER TABLE dashboard_accounts ADD COLUMN IF NOT EXISTS schedule jsonb NOT NULL DEFAULT '[]'::jsonb;
      ALTER TABLE dashboard_accounts ADD COLUMN IF NOT EXISTS schedule_import jsonb;
      ALTER TABLE dashboard_accounts ENABLE ROW LEVEL SECURITY;
      ALTER TABLE dashboard_snapshots ENABLE ROW LEVEL SECURITY;
      ALTER TABLE dashboard_current ENABLE ROW LEVEL SECURITY;
      ALTER TABLE dashboard_guests ENABLE ROW LEVEL SECURITY;
      ALTER TABLE dashboard_crowd_reports ENABLE ROW LEVEL SECURITY;
      ${[...ORG_TABLE_NAMES, ...CLUB_TOOL_TABLE_NAMES].map((t) => `ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;`).join('\n      ')}
      REVOKE ALL ON dashboard_snapshots, dashboard_current, dashboard_guests, dashboard_accounts, dashboard_crowd_reports, ${[...ORG_TABLE_NAMES, ...CLUB_TOOL_TABLE_NAMES].join(', ')} FROM PUBLIC;
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
          REVOKE ALL ON dashboard_snapshots, dashboard_current, dashboard_guests, dashboard_accounts, dashboard_crowd_reports, ${[...ORG_TABLE_NAMES, ...CLUB_TOOL_TABLE_NAMES].join(', ')} FROM anon;
        END IF;
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
          REVOKE ALL ON dashboard_snapshots, dashboard_current, dashboard_guests, dashboard_accounts, dashboard_crowd_reports, ${[...ORG_TABLE_NAMES, ...CLUB_TOOL_TABLE_NAMES].join(', ')} FROM authenticated;
        END IF;
      END $$;
    `);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
