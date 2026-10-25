// `npm run doctor [https://your-domain]`: checks Flowcast's configuration and prints exactly what
// to paste into Google Cloud and Supabase for sign-in to work at that address.
//
// Reads the same variables the host does (the process environment, then .env, then server/.env;
// see package.json). Never prints a secret: only whether each one is set and looks right.
// On Railway, run it as `railway run npm run doctor` to check the service's own variables.

import { createRequire } from 'node:module';

const env = process.env;
const failures = [];
const lines = [];
const ok = (what, detail = '') => lines.push(`  ✓ ${what}${detail ? `  ${detail}` : ''}`);
const warn = (what, fix) => lines.push(`  · ${what}\n      ${fix}`);
const fail = (what, fix) => { failures.push(what); lines.push(`  ✗ ${what}\n      ${fix}`); };

async function withTimeout(promise, ms) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), ms); })]); }
  finally { clearTimeout(timer); }
}

/** The public address people open: an argument, Railway's own domain, or local dev. */
function publicOrigin() {
  const given = process.argv[2] || env.PUBLIC_URL;
  if (given) {
    try { return new URL(given.includes('://') ? given : `https://${given}`).origin; } catch { /* fall through */ }
  }
  if (env.RAILWAY_PUBLIC_DOMAIN) return `https://${env.RAILWAY_PUBLIC_DOMAIN}`;
  return null;
}

// --- Database: the dashboard, accounts and sign-in all need it. -----------------------------
lines.push('Database');
if (!env.DATABASE_URL) {
  fail('DATABASE_URL is not set', 'Without it the API does not start: no sign-in, dashboard or Ask. On Railway: add a PostgreSQL service and set DATABASE_URL to ${{Postgres.DATABASE_URL}}.');
} else {
  let pg;
  try { pg = createRequire(new URL('../server/package.json', import.meta.url))('pg'); } catch { /* not installed */ }
  if (!pg) warn('DATABASE_URL is set (not checked: run npm run build first to install the server)', 'The connection is tested once server/node_modules exists.');
  else {
    const client = new pg.Client({ connectionString: env.DATABASE_URL, connectionTimeoutMillis: 5000 });
    try {
      await withTimeout(client.connect(), 6000);
      await client.query('SELECT 1');
      ok('DATABASE_URL connects', '(tables and data are set up automatically when the server starts)');
    } catch {
      let internal = false;
      try { internal = new URL(env.DATABASE_URL).hostname.endsWith('.railway.internal'); } catch { /* not a URL */ }
      // `railway run` hands this machine the service's private address, which only resolves inside Railway.
      if (internal) warn('DATABASE_URL is Railway\'s private address, which only works inside Railway', 'Not checked from here. The deploy log says "dashboard database ready" once it connects.');
      else fail('DATABASE_URL is set but the database could not be reached', 'Check the URL, that the database is running, and that this machine is allowed to connect.');
    } finally { await client.end().catch(() => {}); }
  }
}

// --- Sign-in: Supabase Auth with Google. ----------------------------------------------------
lines.push('', 'Google sign-in (Supabase)');
let supabase = null;
try {
  const url = new URL(env.SUPABASE_URL ?? '');
  if (url.pathname !== '/' || url.search || url.hash) throw new Error();
  supabase = url.origin;
  ok('SUPABASE_URL', supabase);
} catch {
  fail(env.SUPABASE_URL ? 'SUPABASE_URL is not a plain project URL' : 'SUPABASE_URL is not set', 'Supabase → Project Settings → API: the Project URL, like https://abcdefgh.supabase.co (nothing after the domain).');
}
const key = env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY;
let keyRole = null;
if (key?.startsWith('sb_publishable_')) keyRole = 'publishable';
else if (key?.split('.').length === 3) {
  try { keyRole = JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString()).role ?? null; } catch { /* not a JWT */ }
}
if (!key) fail('SUPABASE_PUBLISHABLE_KEY is not set', 'Supabase → Project Settings → API Keys: the publishable key (sb_publishable_…).');
else if (keyRole === 'publishable' || keyRole === 'anon') ok('SUPABASE_PUBLISHABLE_KEY', `(${keyRole} key)`);
else fail('SUPABASE_PUBLISHABLE_KEY is not a publishable key', 'It is sent to every browser, so it must be the publishable (sb_publishable_…) or legacy anon key, never a secret or service_role key. The server refuses anything else.');

if (supabase && (keyRole === 'publishable' || keyRole === 'anon')) {
  try {
    const response = await withTimeout(fetch(`${supabase}/auth/v1/settings`, { headers: { apikey: key } }), 8000);
    if (!response.ok) throw new Error(String(response.status));
    const settings = await response.json();
    if (settings.external?.google) ok('Google is enabled in Supabase');
    else fail('Google is not enabled in Supabase', 'Supabase → Authentication → Sign In / Providers → Google: turn it on and paste the Google client ID and secret (below).');
  } catch {
    fail('Could not reach Supabase with this URL and key', 'Check that SUPABASE_URL and the key belong to the same project.');
  }
}

// --- Optional features. ------------------------------------------------------------------------
lines.push('', 'Optional');
if (env.OPENAI_KEY || env.OPENAI_API_KEY) ok('OPENAI_KEY is set', '(Ask and voice)');
else warn('OPENAI_KEY is not set', 'Ask Flowcast and voice answer "unavailable" without it. Everything else works.');
if (env.VITE_MAPBOX_TOKEN) ok('VITE_MAPBOX_TOKEN is set', '(read at build time: redeploy after changing it)');
else warn('VITE_MAPBOX_TOKEN is not set', 'The map falls back to plain buildings. Mapbox → Tokens: a public pk.… token, ideally limited to your domain.');
if (env.VITE_MBTA_API_KEY) ok('VITE_MBTA_API_KEY is set');

// --- What to paste where. ----------------------------------------------------------------------
const origin = publicOrigin();
const ref = supabase ?? 'https://<project-ref>.supabase.co';
const site = origin ?? 'https://<your-domain>';
lines.push(
  '',
  'Paste into Google Cloud → APIs & Services',
  '  OAuth consent screen',
  `    App home page:        ${site}/`,
  `    Privacy policy:       ${site}/privacy`,
  `    Authorized domains:   ${supabase ? new URL(supabase).hostname : '<project-ref>.supabase.co'}, ${origin ? new URL(origin).hostname : '<your-domain>'}`,
  '    Scopes:               openid, email, profile (nothing else, so no Google review)',
  '    Publishing status:    In production (in Testing only listed test users can sign in)',
  '  Credentials → OAuth client ID → Web application',
  `    Authorized redirect URI: ${ref}/auth/v1/callback`,
  '    Then copy the client ID and secret into Supabase.',
  '',
  'Paste into Supabase → Authentication',
  '  Sign In / Providers → Google: on, with the client ID and secret from Google',
  '  URL Configuration',
  `    Site URL:       ${site}`,
  `    Redirect URLs:  ${site}/auth/callback`,
  '                    http://localhost:5174/auth/callback   (local dev)',
);
if (!origin) lines.push('', '  (Pass your address to fill these in: npm run doctor https://your-domain. On Railway it is read from RAILWAY_PUBLIC_DOMAIN.)');

console.log(lines.join('\n'));
console.log(failures.length ? `\n${failures.length} thing${failures.length === 1 ? '' : 's'} to fix before sign-in works.` : '\nReady.');
process.exitCode = failures.length ? 1 : 0;
