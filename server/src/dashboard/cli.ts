import { database, migrate } from './db';
import { importSources } from './import';
const pool = database();
if (!pool) { console.error('DATABASE_URL is required.'); process.exitCode = 1; }
else {
  try {
    if (process.argv[2] === 'migrate') { await migrate(pool); console.log('Dashboard migrations applied.'); }
    else if (process.argv[2] === 'import') { console.log(await importSources(pool, process.argv[3])); }
    else throw new Error('Unknown command');
  } catch { console.error('Dashboard database command failed. Check database availability, migrations, and source files.'); process.exitCode = 1; }
  finally { await pool.end(); }
}
